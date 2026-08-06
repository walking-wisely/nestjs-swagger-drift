#!/usr/bin/env node
/**
 * `npx nestjs-swagger-drift --project <tsconfig>` — full Phase 4 flag
 * surface: `--reporter pretty|json`, `--max-depth`, `--fail-on`, `--ignore`
 * (+ `--ignore-status`), per-rule `--enable-rule`/`--disable-rule`,
 * `--base-dir`, `--config`, and inline `swagger-drift-disable-next-line`
 * suppression comments (handled entirely in `core/suppress.ts` — nothing
 * CLI-specific about them). `--routes` keeps Phase 1's plain route-table
 * output available since it's cheap to.
 *
 * ## Exit codes (PLAN §5 Phase 1's policy comment; Phase 4 owns "found drift")
 *
 * Pre-Phase-4, `1` meant two different things depending on which branch of
 * `main()` returned it: a usage error (`--project` missing, a bad tsconfig)
 * AND "the analysis ran cleanly and found real drift." Collapsing those is
 * itself a small silent-failure risk for exactly the audience this tool is
 * built for — a CI step that treats "exit nonzero" as "found drift, block
 * the merge" can't distinguish that from "somebody's config is broken,"
 * which is a very different thing to page someone about. Four codes, kept
 * deliberately small and totally ordered by severity of "how much can you
 * trust this run":
 *
 * - `EXIT_OK` (`0`) — the checker ran and either found nothing, found
 *   nothing that `--fail-on` cares about, or (new in Phase 4) found nothing
 *   because every matching handler was excluded by `--ignore`.
 * - `EXIT_USAGE_ERROR` (`1`) — the invocation itself is wrong: an unknown or
 *   malformed flag, a missing `--project`, an unreadable/unparsable
 *   `swagger-drift.config.*`, or a tsconfig that couldn't be found/parsed.
 *   All of these share one property: nothing was analyzed, and the fix is
 *   to the invocation, not the source under test.
 * - `EXIT_COULD_NOT_ANALYSE` (`2`, reserved since Phase 1) — the invocation
 *   was well-formed and `ts.createProgram` succeeded, but zero handlers were
 *   found *and* `@nestjs/common` itself couldn't be resolved — "I don't
 *   know," not "there's nothing here." See the check below for the full
 *   reasoning (unchanged from Phase 1/2).
 * - `EXIT_FOUND_DRIFT` (`3`, new in Phase 4) — the checker ran to
 *   completion and found at least one finding matched by `--fail-on`
 *   (default: all rules). This is the only code a CI gate should actually
 *   treat as "block the merge."
 * - `EXIT_UNEXPECTED_ERROR` (`4`, post-Phase-4-review fix) — `main()` itself
 *   threw, i.e. a bug in this tool, not a bad invocation and not something
 *   about the analyzed repo. Pre-this-fix, the top-level `.then(_, err =>
 *   ...)` handler at the bottom of this file mapped any uncaught exception
 *   to `EXIT_USAGE_ERROR` — indistinguishable, to a CI wrapper gating on
 *   "exit code 1 means fix your invocation," from an actual usage mistake,
 *   which is exactly backwards: a crash should block a merge (or at least
 *   loudly page someone), not read as "your `--project` flag is wrong."
 *
 * `EXIT_FOUND_DRIFT` deliberately is NOT `1`: reusing it would silently
 * resurrect exactly the ambiguity this section exists to remove the moment
 * any caller pattern-matches on `code !== 0` without reading which nonzero
 * code it got — a real risk, since that's the laziest and most common way
 * to consume a CLI's exit code in a shell script.
 */

import * as ts from 'typescript';
import { pathToFileURL } from 'node:url';
import { dirname, relative, resolve } from 'node:path';
import { createProgramFromTsConfig } from './program.js';
import {
  collectDiscoveryWarnings,
  discoverHandlerMethodNodes,
  discoverHandlers,
} from './discover.js';
import { parseArgs, type CliFlags, type OptionalRuleName } from './args.js';
import { loadConfigFile, type CliConfigFile } from './config.js';
import { isIgnored } from './ignore.js';
import { locationOf } from './report/location.js';
import { reportFindingsJson, reportRoutesJson } from './report/json.js';
import { reportFindingsPretty, reportRoutesPretty } from './report/pretty.js';
import type { AnalysisOptions, Finding, HandlerInfo } from '../core/index.js';
import { analyzeHandler, createAnalysisContext, listDirectiveCommentLines } from '../core/index.js';

function printUsage(): void {
  console.log(
    [
      'Usage: nestjs-swagger-drift --project <path-to-tsconfig-or-dir> [options]',
      '',
      'Options:',
      '  -p, --project <path>        tsconfig.json (or its directory) to analyze. Required',
      '                               unless set via a config file.',
      '      --routes                Print the discovered route table instead of findings.',
      '      --reporter <mode>       "pretty" (default) or "json".',
      '      --max-depth <n>         Call-graph traversal depth (default: 2).',
      '      --fail-on <rules>       "all" (default), "none", or a comma-separated list of',
      '                               rule names that should cause a nonzero exit.',
      '      --ignore <glob>         Exclude matching source files (repeatable).',
      '      --ignore-status <n>     Never report this status code (repeatable).',
      '      --enable-rule <name>    Enable an opt-in rule (repeatable).',
      '      --disable-rule <name>   Disable an opt-in rule (repeatable).',
      '      --treat-default-as-wildcard / --no-treat-default-as-wildcard',
      '      --check-success-response / --no-check-success-response',
      '                               Check for a documented 2xx response (default: on).',
      '      --check-validation-pipe / --no-check-validation-pipe',
      '                               Check for an implicit 400 from a class-validator DTO',
      '                               parameter (default: off).',
      '      --check-guards / --no-check-guards',
      '                               Check @UseGuards(...) classes for implicit 401/403',
      '                               (default: off).',
      '      --base-dir <path>       Base directory for reported file paths',
      '                               (default: the tsconfig\'s own directory).',
      '      --config <path>         Explicit swagger-drift.config.{json,js,mjs,ts} path.',
      '      --no-config             Skip loading/auto-discovering a config file entirely.',
      '      --audit                 Ignore swagger-drift-disable-next-line directives, so',
      '                               every finding they would otherwise hide is reported.',
      '  -h, --help                  Print this message.',
    ].join('\n'),
  );
}

/**
 * "The setup is broken, nothing could be checked" — distinct from `0`
 * ("checked, found nothing to report") and from `EXIT_FOUND_DRIFT`. See the
 * exit-code policy comment above `main()`.
 */
export const EXIT_OK = 0;
export const EXIT_USAGE_ERROR = 1;
export const EXIT_COULD_NOT_ANALYSE = 2;
export const EXIT_FOUND_DRIFT = 3;
/** `main()` itself threw — a bug in this tool, not a bad invocation. See the policy comment above. */
export const EXIT_UNEXPECTED_ERROR = 4;

const ALL_RULE_NAMES = ['undocumented-status', 'documented-but-unreachable', 'unresolvable-status'] as const;
type RuleName = (typeof ALL_RULE_NAMES)[number];

function isRuleName(value: string): value is RuleName {
  return (ALL_RULE_NAMES as readonly string[]).includes(value);
}

/**
 * Parses `--fail-on`'s grammar: `'all'` (every rule name — the default),
 * `'none'` (nothing ever fails the build; findings still print), or a
 * comma-separated subset of `ALL_RULE_NAMES`. Returns `undefined` on a
 * malformed value so the caller can turn that into a usage error rather than
 * silently falling back to a default — same "don't swallow a typo" bar as
 * `args.ts`.
 */
function parseFailOn(raw: string): ReadonlySet<RuleName> | undefined {
  if (raw === 'all') return new Set(ALL_RULE_NAMES);
  if (raw === 'none') return new Set();
  const names = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (names.length === 0) return undefined;
  for (const name of names) {
    if (!isRuleName(name)) return undefined;
  }
  return new Set(names as RuleName[]);
}

function formatDiagnostics(diagnostics: ts.Diagnostic[]): string {
  return ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCurrentDirectory: () => process.cwd(),
    getCanonicalFileName: (f) => f,
    getNewLine: () => '\n',
  });
}

/**
 * Stable sort by path, then HTTP method, then class/method name — the order
 * printed by the CLI and asserted against in
 * `test/integration/discover.test.ts`. Exported so that test asserts against
 * the CLI's real ordering rather than re-implementing it.
 */
export function sortHandlers(handlers: HandlerInfo[]): HandlerInfo[] {
  return [...handlers].sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    if (a.httpMethod !== b.httpMethod) return a.httpMethod < b.httpMethod ? -1 : 1;
    if (a.className !== b.className) return a.className < b.className ? -1 : 1;
    return a.methodName < b.methodName ? -1 : a.methodName > b.methodName ? 1 : 0;
  });
}

/**
 * Stable sort for findings: by handler path/method/class/method name, then
 * status — matches `sortHandlers`'s ordering so the report reads in route
 * order.
 */
function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    if (a.handler.path !== b.handler.path) return a.handler.path < b.handler.path ? -1 : 1;
    if (a.handler.httpMethod !== b.handler.httpMethod) {
      return a.handler.httpMethod < b.handler.httpMethod ? -1 : 1;
    }
    if (a.handler.className !== b.handler.className) {
      return a.handler.className < b.handler.className ? -1 : 1;
    }
    if (a.handler.methodName !== b.handler.methodName) {
      return a.handler.methodName < b.handler.methodName ? -1 : 1;
    }
    const statusA = a.rule === 'unresolvable-status' ? -1 : a.status;
    const statusB = b.rule === 'unresolvable-status' ? -1 : b.status;
    return statusA - statusB;
  });
}

/**
 * `true` if `handler` should be skipped because its source file matches
 * `--ignore`. Compares against the SAME `baseDir`-relative path the report
 * itself prints (`report/location.ts`), so `--ignore 'test/**'` matches
 * whatever the finding's own location line would show, not some other path
 * shape.
 */
function isHandlerIgnored(handler: HandlerInfo, baseDir: string, patterns: readonly string[]): boolean {
  if (patterns.length === 0) return false;
  return isIgnored(locationOf(handler.node, baseDir).file, patterns);
}

/**
 * Merged, fully-resolved CLI configuration: `--flag` (highest precedence) >
 * `swagger-drift.config.*` > built-in default (lowest). Array-shaped options
 * (`ignore`, `ignoreStatuses`) are replaced wholesale by the CLI flag the
 * moment at least one is given, not appended to the config file's list —
 * simpler to reason about than a merge, and an explicit `--ignore` on the
 * command line reads as "use exactly this," not "also ignore this."
 */
interface ResolvedOptions {
  project: string | undefined;
  reporter: 'pretty' | 'json';
  maxDepth: number;
  failOn: ReadonlySet<RuleName>;
  ignore: string[];
  ignoreStatuses: number[];
  rules: Record<OptionalRuleName, boolean>;
  treatDefaultAsWildcard: boolean;
  checkSuccessResponse: boolean;
  checkValidationPipe: boolean;
  checkGuards: boolean;
  baseDir: string | undefined;
  audit: boolean;
}

type MergeResult = { ok: true; options: ResolvedOptions } | { ok: false; error: string };

/**
 * `configPath`, when given, is the config file's own absolute location —
 * used to resolve `config.project`/`config.baseDir` relative to *it*, not to
 * `process.cwd()` (post-Phase-4-review fix). Pre-fix, a `project`/`baseDir`
 * given in a config file was resolved against `cwd`, the same "depends on
 * where the shell happens to be sitting" bug class Phase 4 introduced
 * `baseDir` to fix in the first place — a config file three directories up
 * from `cwd` with `"project": "./tsconfig.json"` meant "the tsconfig next to
 * *this config file*" to whoever wrote it, not "next to wherever the CLI
 * gets invoked from." An explicit `--project`/`--base-dir` flag is still
 * resolved against `cwd` (unchanged), since that's genuinely what a flag
 * typed at a shell prompt means.
 */
/**
 * Exported (not just used internally by `main()`) so `--enable-rule`/
 * `--disable-rule`'s actual effect — merging into `AnalysisOptions.rules` —
 * is directly testable (Phase 4 review, finding S11): those two rules
 * (`documented-but-unreachable`, `unresolvable-status`) are opt-in and not
 * yet consulted by `analyzeHandler` (Phase 5, PLAN §4.1c), so there is no
 * end-to-end *behavioral* difference to assert on yet — the only thing
 * actually exercisable today is that the flags reach `AnalysisOptions.rules`
 * at all, which a black-box `main()` test that never inspects that field
 * can't observe.
 */
export function mergeOptions(flags: CliFlags, config: CliConfigFile, configPath: string | undefined): MergeResult {
  const reporter = flags.reporter ?? (config.reporter as 'pretty' | 'json' | undefined) ?? 'pretty';
  if (reporter !== 'pretty' && reporter !== 'json') {
    return { ok: false, error: `config "reporter" must be "pretty" or "json", got "${config.reporter}"` };
  }

  const failOnRaw = flags.failOn ?? config.failOn ?? 'all';
  const failOn = parseFailOn(failOnRaw);
  if (failOn === undefined) {
    return {
      ok: false,
      error:
        `--fail-on / config "failOn" must be "all", "none", or a comma-separated list of ` +
        `${ALL_RULE_NAMES.join(', ')}; got "${failOnRaw}"`,
    };
  }

  const rules: Record<OptionalRuleName, boolean> = {
    'documented-but-unreachable': config.rules?.['documented-but-unreachable'] ?? false,
    'unresolvable-status': config.rules?.['unresolvable-status'] ?? false,
  };
  for (const name of flags.enableRules) rules[name] = true;
  for (const name of flags.disableRules) rules[name] = false;

  const configDir = configPath !== undefined ? dirname(configPath) : undefined;
  const resolveFromConfig = (value: string | undefined): string | undefined =>
    value !== undefined && configDir !== undefined ? resolve(configDir, value) : value;

  return {
    ok: true,
    options: {
      project: flags.project ?? resolveFromConfig(config.project),
      reporter,
      maxDepth: flags.maxDepth ?? config.maxDepth ?? 2,
      failOn,
      ignore: flags.ignore.length > 0 ? flags.ignore : (config.ignore ?? []),
      ignoreStatuses:
        flags.ignoreStatuses.length > 0 ? flags.ignoreStatuses : (config.ignoreStatuses ?? []),
      rules,
      treatDefaultAsWildcard: flags.treatDefaultAsWildcard ?? config.treatDefaultAsWildcard ?? false,
      // §4.1c / §9: success-checking is the one implicit-codes check that's
      // on by default; the other two stay off unless explicitly requested,
      // matching `AnalysisOptions`'s own field-level defaults in `types.ts`.
      checkSuccessResponse: flags.checkSuccessResponse ?? config.checkSuccessResponse ?? true,
      checkValidationPipe: flags.checkValidationPipe ?? config.checkValidationPipe ?? false,
      checkGuards: flags.checkGuards ?? config.checkGuards ?? false,
      baseDir: flags.baseDir ?? resolveFromConfig(config.baseDir),
      audit: flags.audit,
    },
  };
}

export async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    console.error(`nestjs-swagger-drift: ${parsed.error}`);
    printUsage();
    return EXIT_USAGE_ERROR;
  }
  const { flags } = parsed;

  if (flags.help) {
    printUsage();
    return EXIT_OK;
  }

  if (flags.noConfig && flags.config !== undefined) {
    console.error('nestjs-swagger-drift: --no-config and --config cannot be used together.');
    return EXIT_USAGE_ERROR;
  }

  // `--no-config` (post-Phase-4-review fix) skips loading a config file
  // entirely, including auto-discovery: without it, a
  // `swagger-drift.config.js` merely *sitting in cwd* — never referenced on
  // the command line at all — silently ran arbitrary code and could set
  // e.g. `failOn: 'none'` to turn a genuinely drifting repo green, with the
  // discovered path never printed anywhere. This flag is the escape hatch;
  // printing the path below (whenever a config *was* loaded) is the fix for
  // the "never printed" half of that problem.
  const configResult: Awaited<ReturnType<typeof loadConfigFile>> = flags.noConfig
    ? { ok: true, config: {}, path: undefined }
    : await loadConfigFile(flags.config, process.cwd());
  if (!configResult.ok) {
    console.error(`nestjs-swagger-drift: ${configResult.error}`);
    return EXIT_USAGE_ERROR;
  }
  if (configResult.path !== undefined) {
    console.error(`nestjs-swagger-drift: using config file: ${configResult.path}`);
  }

  const merged = mergeOptions(flags, configResult.config, configResult.path);
  if (!merged.ok) {
    console.error(`nestjs-swagger-drift: ${merged.error}`);
    return EXIT_USAGE_ERROR;
  }
  const options = merged.options;

  if (!options.project) {
    console.error(
      'nestjs-swagger-drift: --project is required (set it on the command line or in ' +
        'swagger-drift.config.{json,js,mjs,ts}).',
    );
    printUsage();
    return EXIT_USAGE_ERROR;
  }

  const outcome = createProgramFromTsConfig(options.project);
  if (!outcome.ok) {
    switch (outcome.error.kind) {
      case 'config-not-found':
        console.error(
          `nestjs-swagger-drift: could not find a tsconfig at ${outcome.error.configPath}`,
        );
        break;
      case 'config-read-error':
        console.error(
          `nestjs-swagger-drift: failed to read ${outcome.error.configPath}: ${outcome.error.message}`,
        );
        break;
      case 'config-parse-error':
        console.error(`nestjs-swagger-drift: failed to parse ${outcome.error.configPath}:`);
        console.error(formatDiagnostics(outcome.error.diagnostics));
        break;
    }
    // A tsconfig that can't be found/read/parsed means nothing was
    // analyzed — a setup problem with the invocation, same bucket as a bad
    // flag (see the exit-code policy comment above `main()`), not
    // `EXIT_COULD_NOT_ANALYSE` (which is specifically "the program built
    // fine but @nestjs/common didn't resolve").
    return EXIT_USAGE_ERROR;
  }

  const { program, configDiagnostics, configPath } = outcome.result;
  if (configDiagnostics.length > 0) {
    console.error(formatDiagnostics(configDiagnostics));
  }

  // B2: silence here is exactly the failure mode a CI tool must not have —
  // an unresolved `@nestjs/common` or a rejected same-named decorator must
  // never look identical to "this repo genuinely has no controllers".
  const warnings = collectDiscoveryWarnings(program);
  for (const warning of warnings) {
    console.error(`nestjs-swagger-drift: warning: ${warning.message}`);
  }

  // Base directory for every reported path (Phase 4 fix): the tsconfig's
  // own directory, not `process.cwd()`. `cwd` degrades to `../../../../src/
  // foo.ts`-style paths the moment the CLI is invoked from anywhere other
  // than the analyzed project's root (a monorepo task runner, an `npx`
  // invocation from a parent directory, ...) — the tsconfig's directory is
  // the one stable anchor that's actually about the project being analyzed,
  // not about where the shell happened to be sitting. `--base-dir`
  // overrides it for callers who want something else (e.g. reporting paths
  // relative to a monorepo root instead of the package's own tsconfig).
  const baseDir = options.baseDir !== undefined
    ? resolve(process.cwd(), options.baseDir)
    : dirname(configPath);

  const allHandlers = sortHandlers(discoverHandlers(program));
  if (allHandlers.length === 0) {
    // Exit code policy (Phase 1 review, follow-up): a zero-route result
    // reached because `@nestjs/common` itself couldn't be resolved is a
    // different outcome from a zero-route result reached by successfully
    // checking a repo that genuinely has no controllers — collapsing
    // "couldn't analyse" into the same exit code as "analysed, found
    // nothing" is precisely the silent-green failure this tool exists to
    // prevent.
    const couldNotAnalyse = warnings.some((w) => w.kind === 'unresolved-module');
    if (couldNotAnalyse) {
      console.error(
        'nestjs-swagger-drift: could not analyse — @nestjs/common could not be resolved for ' +
          'this tsconfig (see warnings above), so this result does not mean "no controllers found."',
      );
      return EXIT_COULD_NOT_ANALYSE;
    }
    // `--reporter json` must never fall through to a prose sentence here
    // (post-Phase-4-review fix): `cli --reporter json | jq` on an empty repo
    // used to crash on invalid JSON, because this early-return path printed
    // "No @Controller handlers found." unconditionally, ignoring `options.reporter`
    // entirely. The informational message still goes out — to stderr, via
    // `console.error`, so it doesn't corrupt stdout's JSON — either way.
    if (options.reporter === 'json') {
      console.error('nestjs-swagger-drift: no @Controller handlers found.');
      console.log(flags.routes ? reportRoutesJson([], baseDir) : reportFindingsJson([], baseDir, []));
    } else {
      console.log('No @Controller handlers found.');
    }
    return EXIT_OK;
  }

  const handlers = allHandlers.filter((h) => !isHandlerIgnored(h, baseDir, options.ignore));
  if (handlers.length === 0) {
    // Distinct from the "genuinely zero controllers" branch above: routes
    // exist, the user's own `--ignore` excluded all of them. Reported
    // plainly rather than reusing "No @Controller handlers found." — that
    // message would be actively misleading here (it reads as "there aren't
    // any," when the true state is "there are N, and you asked to skip all
    // of them"). Same JSON-must-stay-JSON fix as above.
    if (options.reporter === 'json') {
      console.error(
        `nestjs-swagger-drift: all ${allHandlers.length} @Controller handler(s) were excluded by --ignore.`,
      );
      console.log(flags.routes ? reportRoutesJson([], baseDir) : reportFindingsJson([], baseDir, []));
    } else {
      console.log(`All ${allHandlers.length} @Controller handler(s) were excluded by --ignore.`);
    }
    return EXIT_OK;
  }

  if (flags.routes) {
    console.log(
      options.reporter === 'json' ? reportRoutesJson(handlers, baseDir) : reportRoutesPretty(handlers),
    );
    return EXIT_OK;
  }

  const analysisOptions: AnalysisOptions = {
    maxDepth: options.maxDepth,
    rules: options.rules,
    treatDefaultAsWildcard: options.treatDefaultAsWildcard,
    ignoreStatuses: options.ignoreStatuses,
    checkSuccessResponse: options.checkSuccessResponse,
    checkValidationPipe: options.checkValidationPipe,
    checkGuards: options.checkGuards,
    // `--audit` (post-Phase-4-review fix, finding S6): ignore inline
    // suppression directives entirely, so every finding they'd otherwise
    // hide — including a directive in a shared service silently affecting
    // every caller — is reported like any other finding. The escape hatch
    // for "what is this repo's suppression policy actually hiding."
    ignoreSuppressions: options.audit,
  };

  // Findings are the primary output (PLAN §4.4). Analyzed once per distinct
  // method node — not once per already-expanded `HandlerInfo` — since
  // `analyzeHandler` itself expands back out over every `HandlerInfo` a
  // method yields; analyzing per-`HandlerInfo` here too would duplicate
  // findings for a method with two HTTP decorators or an array-form path.
  const ctx = createAnalysisContext(program, analysisOptions);
  const methodNodes = discoverHandlerMethodNodes(program).filter(
    (node) => !isIgnored(locationOf(node, baseDir).file, options.ignore),
  );

  // Suppression is otherwise invisible (post-Phase-4-review fix, finding
  // S6/S5): `suppressedCount` surfaces how many findings a directive
  // silenced (printed below, and in the JSON summary), and
  // `usedDirectiveLines` — cross-referenced against every
  // `swagger-drift-disable-next-line` comment actually present in the
  // analyzed files — lets us warn about a directive that suppressed
  // nothing at all (a typo'd placement, a status that was never going to
  // be reported, or one left behind after the throw it targeted was
  // removed).
  let suppressedCount = 0;
  const usedDirectiveLines = new Set<string>();
  // Every file an `analyzeHandler` call for a non-ignored handler actually
  // looked at for suppression purposes (own file + every `StatusSource`
  // file — see `analyzeHandler`'s `onAnalyzedFile` doc comment). A file
  // reached only through an `--ignore`d handler's call graph (a shared
  // service whose only caller was excluded) never lands here, so its
  // directives are correctly treated as out of scope below rather than
  // flagged as unused — same "silence over noise" contract `--ignore`
  // gives everything else.
  const analyzedFiles = new Set<string>();
  const findings = sortFindings(
    methodNodes.flatMap((node) =>
      analyzeHandler(
        node,
        ctx,
        (suppressed) => {
          suppressedCount++;
          usedDirectiveLines.add(`${suppressed.file}:${suppressed.line}`);
        },
        (fileName) => analyzedFiles.add(fileName),
      ),
    ),
  );
  const failingFindings = findings.filter((f) => options.failOn.has(f.rule));

  if (!options.audit) {
    for (const sourceFile of program.getSourceFiles()) {
      if (sourceFile.isDeclarationFile) continue;
      if (sourceFile.fileName.includes('/node_modules/')) continue;
      const relativePath = relative(baseDir, sourceFile.fileName).split('\\').join('/');
      // Same exclusion the finding pass already applies to `methodNodes`
      // above — a file the user excluded via `--ignore` must not surface
      // "unused directive" warnings either. `analyzedFiles` additionally
      // covers the file reached only via the call graph of an ignored
      // handler (see the comment on its declaration above). Without both,
      // `--ignore`ing a file (e.g. generated or migrating code) that still
      // carries suppression comments — directly or transitively — produces
      // permanent, unsilenceable CI log noise.
      if (isIgnored(relativePath, options.ignore)) continue;
      if (!analyzedFiles.has(sourceFile.fileName)) continue;
      for (const line of listDirectiveCommentLines(sourceFile)) {
        if (usedDirectiveLines.has(`${sourceFile.fileName}:${line}`)) continue;
        console.error(
          `nestjs-swagger-drift: warning: suppression directive at ${relativePath}:${line} ` +
            'did not suppress anything.',
        );
      }
    }
  }

  if (options.reporter === 'json') {
    console.log(reportFindingsJson(findings, baseDir, failingFindings, suppressedCount));
  } else if (findings.length === 0) {
    console.log('No undocumented status codes found.');
  } else {
    console.log(reportFindingsPretty(findings, baseDir));
  }

  if (findings.length > 0 || suppressedCount > 0) {
    console.error(
      `nestjs-swagger-drift: found ${findings.length} finding(s), ${failingFindings.length} ` +
        `matched by --fail-on, ${suppressedCount} suppressed.`,
    );
  }

  return failingFindings.length > 0 ? EXIT_FOUND_DRIFT : EXIT_OK;
}

/* c8 ignore start -- exercised via the built CLI binary, not unit tests */
const entryUrl = process.argv[1] === undefined ? undefined : pathToFileURL(process.argv[1]).href;
if (import.meta.url === entryUrl) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error('nestjs-swagger-drift: unexpected error:', err);
      process.exit(EXIT_UNEXPECTED_ERROR);
    },
  );
}
/* c8 ignore stop */
