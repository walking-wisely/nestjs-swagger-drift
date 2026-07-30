#!/usr/bin/env node
/**
 * `--project <tsconfig>` in; by default, `undocumented-status` findings out
 * (PLAN §4.4) — this is Phase 2's exit criterion: a real undocumented `404`
 * in a fixture must be found and the process must exit `1`. `--routes`
 * keeps Phase 1's plain route-table output available since it's cheap to.
 * Full flag surface (reporters, `--fail-on`, config file, `--strict`,
 * `--max-depth`, `--ignore`, suppression comments, ...) is PLAN.md Phase 4 —
 * deliberately not built here.
 */

import * as ts from 'typescript';
import { pathToFileURL } from 'node:url';
import { relative } from 'node:path';
import { createProgramFromTsConfig } from './program.js';
import {
  collectDiscoveryWarnings,
  discoverHandlerMethodNodes,
  discoverHandlers,
} from './discover.js';
import type { AnalysisOptions, Finding, HandlerInfo, StatusSource } from '../core/index.js';
import { analyzeHandler, createAnalysisContext } from '../core/index.js';

function printUsage(): void {
  console.log('Usage: nestjs-swagger-drift --project <path-to-tsconfig-or-dir> [--routes]');
}

/**
 * Phase 2's default `AnalysisOptions`. `treatDefaultAsWildcard: false`
 * matches `DocumentedStatus`'s own doc comment ("satisfies nothing specific
 * *by default*"); the opt-in rules stay off; `ignoreStatuses` is empty.
 * `maxDepth` is unused until Phase 3's call graph exists but is set to the
 * value PLAN §4.1b names as the eventual default.
 */
function defaultAnalysisOptions(): AnalysisOptions {
  return {
    maxDepth: 2,
    rules: {
      'documented-but-unreachable': false,
      'unresolvable-status': false,
    },
    treatDefaultAsWildcard: false,
    ignoreStatuses: [],
  };
}

/**
 * "The setup is broken, nothing could be checked" — distinct from `0`
 * ("checked, found nothing to report") and reserved from whatever exit code
 * Phase 4's `--fail-on` assigns to "found drift" once that exists. See the
 * exit-code policy comment where this is used, in `main()`.
 */
export const EXIT_COULD_NOT_ANALYSE = 2;

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

function formatHandler(handler: HandlerInfo): string {
  // A path built from an unresolved segment (a template interpolation, a
  // non-literal const, ...) is a best-effort guess, not fact — marking it
  // rather than printing it plainly, per the Phase 1 review (B1): silently
  // wrong routes are worse than visibly incomplete ones, since every later
  // finding is reported through this same path.
  const path = handler.unresolvedPath ? `${handler.path} <unresolved>` : handler.path;
  return `${handler.httpMethod} ${path} → ${handler.className}.${handler.methodName}`;
}

/**
 * `core/` hands out `ts.Node`s whose source files carry whatever absolute
 * (or cwd-relative-as-given-to-the-compiler) path `ts.createProgram` used —
 * `core/` itself stays Node-free and must not know about `cwd` at all (PLAN
 * §3), so the relative-path conversion PLAN §4.4's report format wants
 * (`src/users/users.controller.ts:42:3`, not an absolute path — breaks
 * editor/CI annotation linking otherwise) lives here, in `cli/`, only.
 */
function locationOf(node: ts.Node, baseDir: string): string {
  const sourceFile = node.getSourceFile();
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
  const relativePath = relative(baseDir, sourceFile.fileName) || sourceFile.fileName;
  return `${relativePath}:${line + 1}:${character + 1}`;
}

/** Label for a `StatusSource`, for the `└ ...` report line under each status. */
function describeSource(source: StatusSource, baseDir: string): string {
  switch (source.kind) {
    case 'throw':
      return `direct throw  ${locationOf(source.node, baseDir)}`;
    case 'service-throw':
      return `${source.via.map((hop) => hop.name).join(' → ')}  ${locationOf(source.node, baseDir)}`;
    case 'implicit':
      return `implicit (${source.reason})  ${locationOf(source.node, baseDir)}`;
  }
}

/**
 * PLAN §4.4's report shape. Phase 2 only ever produces `undocumented-status`
 * findings (the opt-in rules aren't implemented yet), but this switches on
 * `rule` so a future rule can't silently print nothing.
 */
function formatFinding(finding: Finding, baseDir: string): string {
  if (finding.rule === 'undocumented-status') {
    const { handler, status, sources } = finding;
    const exceptionNames = [
      ...new Set(sources.map((s) => (s.kind === 'implicit' ? s.reason : s.exception))),
    ];
    const lines = [
      `${locationOf(handler.node, baseDir)}  error`,
      `  ${handler.httpMethod} ${handler.path} (${handler.className}.${handler.methodName}) is missing @ApiResponse for:`,
      `    ${status} ${exceptionNames.join(', ')}`,
      ...sources.map((s) => `       └ ${describeSource(s, baseDir)}`),
    ];
    return lines.join('\n');
  }
  // `documented-but-unreachable` / `unresolvable-status`: opt-in, unimplemented in Phase 2.
  return `${locationOf(finding.node, baseDir)}  error  ${finding.rule}`;
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

function parseArgs(argv: string[]): { project?: string; routes: boolean } {
  const result: { project?: string; routes: boolean } = { routes: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--project' || arg === '-p') {
      const value = argv[i + 1];
      if (value !== undefined) result.project = value;
      i++;
    } else if (arg === '--routes') {
      result.routes = true;
    }
  }
  return result;
}

export function main(argv: string[]): number {
  const args = parseArgs(argv);
  if (!args.project) {
    printUsage();
    return 1;
  }

  const outcome = createProgramFromTsConfig(args.project);
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
    return 1;
  }

  const { program, configDiagnostics } = outcome.result;
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

  const handlers = sortHandlers(discoverHandlers(program));
  if (handlers.length === 0) {
    // Exit code policy (Phase 1 review, follow-up): a zero-route result
    // reached because `@nestjs/common` itself couldn't be resolved is a
    // different outcome from a zero-route result reached by successfully
    // checking a repo that genuinely has no controllers — the plan's whole
    // premise is CI trustworthiness, and collapsing "couldn't analyse" into
    // the same exit code as "analysed, found nothing" is precisely the
    // silent-green failure this tool exists to prevent. `EXIT_COULD_NOT_ANALYSE`
    // (2) is reserved for that case and is deliberately distinct from the
    // future Phase 4 "found drift" exit code, which hasn't been assigned yet
    // and isn't built here — Phase 4 owns the general `--fail-on` surface.
    const couldNotAnalyse = warnings.some((w) => w.kind === 'unresolved-module');
    if (couldNotAnalyse) {
      console.error(
        'nestjs-swagger-drift: could not analyse — @nestjs/common could not be resolved for ' +
          'this tsconfig (see warnings above), so this result does not mean "no controllers found."',
      );
      return EXIT_COULD_NOT_ANALYSE;
    }
    console.log('No @Controller handlers found.');
    return 0;
  }

  if (args.routes) {
    for (const handler of handlers) {
      console.log(formatHandler(handler));
    }
    return 0;
  }

  // Findings are the primary output (PLAN §4.4). Analyzed once per distinct
  // method node — not once per already-expanded `HandlerInfo` — since
  // `analyzeHandler` itself expands back out over every `HandlerInfo` a
  // method yields; analyzing per-`HandlerInfo` here too would duplicate
  // findings for a method with two HTTP decorators or an array-form path.
  const ctx = createAnalysisContext(program, defaultAnalysisOptions());
  const methodNodes = discoverHandlerMethodNodes(program);
  const findings = sortFindings(methodNodes.flatMap((node) => analyzeHandler(node, ctx)));

  if (findings.length === 0) {
    console.log('No undocumented status codes found.');
    return 0;
  }

  const baseDir = process.cwd();
  for (const finding of findings) {
    console.log(formatFinding(finding, baseDir));
  }
  console.error(
    `nestjs-swagger-drift: found ${findings.length} undocumented status code finding(s).`,
  );

  return 1;
}

/* c8 ignore start -- exercised via the built CLI binary, not unit tests */
const entryUrl = process.argv[1] === undefined ? undefined : pathToFileURL(process.argv[1]).href;
if (import.meta.url === entryUrl) {
  process.exit(main(process.argv.slice(2)));
}
/* c8 ignore stop */
