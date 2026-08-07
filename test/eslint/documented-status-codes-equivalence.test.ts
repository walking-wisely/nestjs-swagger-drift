/**
 * PLAN §5 Phase 6's exit criterion, verified directly: "the plugin catches
 * the same findings as the CLI on the same fixtures." Runs BOTH drivers over
 * the SAME fixture projects — `analyzeHandler` directly (the CLI's own path,
 * see `test/integration/analyze.test.ts`) and the ESLint rule (via a plain
 * `Linter.verify`, not `RuleTester` — `RuleTester` is for asserting individual
 * cases, not for driving a whole fixture directory, and a plain `Linter` is
 * exactly what a real `eslint.config.js` uses under the hood) — and asserts
 * they find the same set of findings, per PLAN §5 Phase 6's own wording.
 *
 * Covers `basic` (no throws at all — exercises the on-by-default implicit
 * success-status check exclusively), `status-diff` (the main throw/
 * call-graph/documented-decorator corpus), and `implicit-codes` (the only
 * fixture with a `@UseGuards(...)` class and a `class-validator`-decorated
 * DTO parameter — see below), under two option profiles: the real shipped
 * defaults, and a profile with every opt-in check turned on — proving the
 * rule's option-to-`AnalysisOptions` translation isn't just correct for the
 * (mostly inert) defaults.
 *
 * `implicit-codes` in the `ALL_RULES_OPTIONS` profile specifically is what
 * exercises `checkGuards`/`checkValidationPipe`'s options -> `AnalysisOptions`
 * translation (`documented-status-codes.ts`'s `create()`): `basic` and
 * `status-diff` alone contain no `@UseGuards(...)` class and no
 * `class-validator`-decorated DTO, so those two fields' wiring was
 * previously unverified by this suite (Phase 6 review finding M3) — provably
 * so, since hardcoding both to `false` in the adapter left every other case
 * here green. Confirmed by mutation-testing that exact regression (see PR
 * history / review notes) before landing this fixture addition.
 */

import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { Linter } from 'eslint';
import tsParser from '@typescript-eslint/parser';
import { createProgramFromTsConfig } from '../../src/cli/program.js';
import { discoverHandlerMethodNodes } from '../../src/cli/discover.js';
import { analyzeHandler, createAnalysisContext, type AnalysisOptions, type Finding } from '../../src/core/index.js';
import nestjsSwaggerDriftEslint from '../../src/eslint/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Every `.ts` file directly under `dir` (fixtures here are flat — no nested subdirectories to recurse into). */
function listTsFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => join(dir, name));
}

/**
 * A canonical, driver-independent key for a `Finding`/ESLint message pair —
 * deliberately excludes line/column (the two drivers anchor at slightly
 * different but equally defensible nodes for e.g. `unresolvable-status`; see
 * `documented-status-codes.ts`'s `reportNodeFor` doc comment) and instead
 * keys on what the finding actually MEANS: which rule, which handler, and
 * which status/exception-set/detail. Mirrors both `cli/report/pretty.ts`'s
 * and the ESLint rule's own message construction closely enough that a
 * divergence in either would show up as a set mismatch below.
 */
function keyFor(rule: string, handlerLabel: string, statusOrDetail: string, extra = ''): string {
  return `${rule}|${handlerLabel}|${statusOrDetail}|${extra}`;
}

function handlerLabel(handler: Finding['handler']): string {
  return `${handler.httpMethod} ${handler.path} (${handler.className}.${handler.methodName})`;
}

/** `analyzeHandler`-driven keys for every handler method node in `program` — the CLI's own path (PLAN §2.1), reused directly here rather than shelling out to the built CLI binary. */
function analyzeViaCore(program: ReturnType<typeof createProgramFromTsConfig>, options: AnalysisOptions): Set<string> {
  if (!program.ok) throw new Error('failed to build program');
  const ctx = createAnalysisContext(program.result.program, options);
  const keys = new Set<string>();
  for (const node of discoverHandlerMethodNodes(program.result.program)) {
    for (const finding of analyzeHandler(node, ctx)) {
      if (finding.rule === 'undocumented-status') {
        const exceptions = [
          ...new Set(finding.sources.map((s) => (s.kind === 'implicit' ? s.reason : s.exception))),
        ]
          .sort()
          .join(',');
        keys.add(keyFor(finding.rule, handlerLabel(finding.handler), String(finding.status), exceptions));
      } else if (finding.rule === 'documented-but-unreachable') {
        keys.add(keyFor(finding.rule, handlerLabel(finding.handler), String(finding.status)));
      } else {
        keys.add(keyFor(finding.rule, handlerLabel(finding.handler), finding.detail));
      }
    }
  }
  return keys;
}

/** ESLint-rule-driven keys for every `.ts` file in `fixtureDir/src` — a plain `Linter.verify` per file, exactly what `eslint.config.js` + this plugin's `configs.recommended` does under the hood. */
function analyzeViaEslint(fixtureDir: string, options: Partial<AnalysisOptions>): Set<string> {
  const linter = new Linter();
  const keys = new Set<string>();

  for (const file of listTsFiles(join(fixtureDir, 'src'))) {
    const code = readFileSync(file, 'utf8');
    const messages = linter.verify(
      code,
      [
        {
          files: ['**/*.ts'],
          // Cast: `@typescript-eslint/utils`'s `TSESLint.FlatConfig.Plugin`
          // (what our plugin object is typed as, in `src/eslint/index.ts`)
          // and plain `eslint`'s own `Linter.Config['plugins']` type are
          // structurally the same shape at runtime — this is exactly what a
          // real `eslint.config.js` does with any typescript-eslint plugin —
          // but their independently-declared `.d.ts`s disagree just enough
          // under `exactOptionalPropertyTypes` for `tsc` to reject the
          // assignment. Type-only friction between the two packages' config
          // types, not a real runtime mismatch: `documented-status-codes.test.ts`
          // exercises this exact plugin object through `RuleTester` (built on
          // the SAME `@typescript-eslint/utils` types) without any cast, and
          // the plain-Linter smoke check in this file's own dev history ran
          // the identical config successfully.
          plugins: { 'nestjs-swagger-drift': nestjsSwaggerDriftEslint } as NonNullable<Linter.Config['plugins']>,
          languageOptions: {
            parser: tsParser,
            parserOptions: {
              project: './tsconfig.json',
              tsconfigRootDir: fixtureDir,
              ecmaVersion: 'latest',
              sourceType: 'module',
              // Root cause of a real (CI-only, `CI=true`-triggered) CLI/ESLint
              // parity gap: `@typescript-eslint/typescript-estree`'s
              // `inferSingleRun` (`parseSettings/inferSingleRun.js`) treats
              // `process.env.CI === 'true'` as "this is a one-shot CLI lint",
              // and in that mode it tracks how many times `parseAndGenerateServices`
              // has been called for each exact file PATH across the whole
              // process (`parser.js`'s module-level `parseAndGenerateServicesCalls`
              // counter) — a heuristic meant to detect ESLint's own internal
              // `--fix` multi-pass loop re-parsing a fixed-up file. The SECOND
              // time it sees the same path, it silently swaps the real,
              // full-cross-file-type-info `ts.Program` for `createIsolatedProgram`'s
              // "quickest possible" per-file program — which is why, under
              // `CI=true`, only the SECOND `it` block sharing a fixture
              // (`ALL_RULES_OPTIONS`, since `DEFAULT_OPTIONS` always runs
              // first for the same fixture dir) lost cross-file resolution
              // (custom exception classes, typed rethrows, etc.) that
              // `analyzeHandler`'s own single, freshly-built `ts.Program`
              // (`analyzeViaCore`) never loses.
              //
              // This is a property of THIS TEST's driving methodology, not of
              // real ESLint usage: a real `eslint` CLI invocation parses each
              // file exactly once per process, so it never trips the "called
              // more than once" branch in the first place — only this file's
              // deliberate re-`Linter.verify()`-ing of the SAME fixture paths
              // across multiple `describe.each` option profiles does.
              // `disallowAutomaticSingleRunInference` (the parser's own
              // documented escape hatch — `parser-options.d.ts`) opts back
              // into always building the full project program, matching what
              // both drivers get in every other environment (this bug is
              // invisible without `CI=true`, which is exactly why it only
              // showed up in GitHub Actions, never locally).
              disallowAutomaticSingleRunInference: true,
            },
          },
          rules: { 'nestjs-swagger-drift/documented-status-codes': ['error', options] },
        },
      ],
      file,
    );

    for (const message of messages) {
      // `Linter.verify`'s returned `LintMessage`s carry the already-interpolated
      // `.message` string, not the raw `data` object `context.report` was given
      // (that's an ESLint internal, not part of the public result) — so this
      // parses the three message templates back apart with the inverse of the
      // `meta.messages` template each one was built from
      // (`documented-status-codes.ts`), rather than trying to read `data` off
      // the message (which doesn't exist on the returned object at all).
      let match: RegExpMatchArray | null;
      if (message.messageId === 'undocumentedStatus') {
        match = /^(.*) is missing @ApiResponse for (\d+) \((.*)\)\.$/.exec(message.message);
        if (!match) throw new Error(`unparsable undocumentedStatus message: ${message.message}`);
        const [, handler, status, exceptions] = match;
        keys.add(
          keyFor(
            'undocumented-status',
            handler ?? '',
            status ?? '',
            (exceptions ?? '')
              .split(', ')
              .sort()
              .join(','),
          ),
        );
      } else if (message.messageId === 'documentedButUnreachable') {
        match = /^(.*) documents (\d+), but nothing in this run produces it \(documented-but-unreachable\)\.$/.exec(
          message.message,
        );
        if (!match) throw new Error(`unparsable documentedButUnreachable message: ${message.message}`);
        const [, handler, status] = match;
        keys.add(keyFor('documented-but-unreachable', handler ?? '', status ?? ''));
      } else if (message.messageId === 'unresolvableStatus') {
        match = /^(.*) has (?:a throw|an @HttpCode\(\.\.\.\)) whose status could not be resolved: (.*) \(unresolvable-status\)\.$/.exec(
          message.message,
        );
        if (!match) throw new Error(`unparsable unresolvableStatus message: ${message.message}`);
        const [, handler, rawDetail] = match;
        // m7 (Phase 6 review): a cross-file `unresolvable-status` finding's
        // ESLint-side `detail` carries an extra `(at file:line)` suffix the
        // CLI's own `finding.detail` does NOT have (`documented-status-codes.ts`'s
        // `crossFileLocation`) — an intentional, documented divergence
        // between the two drivers' message text, not a meaning difference,
        // so it's stripped here before keying rather than either dropping
        // the enrichment or making the two surfaces fight to stay
        // byte-for-byte identical.
        const detail = (rawDetail ?? '').replace(/ \(at .+:\d+\)$/, '');
        keys.add(keyFor('unresolvable-status', handler ?? '', detail));
      } else {
        throw new Error(`unexpected ESLint message: ${JSON.stringify(message)} in ${relative(fixtureDir, file)}`);
      }
    }
  }

  return keys;
}

const DEFAULT_OPTIONS: AnalysisOptions = {
  maxDepth: 2,
  rules: { 'documented-but-unreachable': false, 'unresolvable-status': false },
  treatDefaultAsWildcard: false,
  ignoreStatuses: [],
  checkSuccessResponse: true,
  checkValidationPipe: false,
  checkGuards: false,
  checkParsePipes: false,
};

const ALL_RULES_OPTIONS: AnalysisOptions = {
  maxDepth: 2,
  rules: { 'documented-but-unreachable': true, 'unresolvable-status': true },
  treatDefaultAsWildcard: true,
  ignoreStatuses: [],
  checkSuccessResponse: true,
  checkValidationPipe: true,
  checkGuards: true,
  checkParsePipes: true,
};

describe.each([
  ['basic', DEFAULT_OPTIONS],
  ['basic', ALL_RULES_OPTIONS],
  ['status-diff', DEFAULT_OPTIONS],
  ['status-diff', ALL_RULES_OPTIONS],
  ['implicit-codes', DEFAULT_OPTIONS],
  ['implicit-codes', ALL_RULES_OPTIONS],
] as const)('CLI/ESLint parity on the %s fixture (%o)', (fixtureName, options) => {
  const fixtureDir = join(__dirname, `../fixtures/${fixtureName}`);

  it('the ESLint rule flags exactly the same findings as analyzeHandler (the CLI\'s own path)', () => {
    const program = createProgramFromTsConfig(join(fixtureDir, 'tsconfig.json'));
    const coreKeys = analyzeViaCore(program, options);
    const eslintKeys = analyzeViaEslint(fixtureDir, options);

    expect([...eslintKeys].sort()).toEqual([...coreKeys].sort());
    // A non-empty corpus assertion: an accidentally-inert rule (e.g. a typo
    // in the messageId map, or options that silently didn't wire through)
    // would otherwise pass the equality check above vacuously by both sides
    // being empty.
    if (fixtureName === 'status-diff' || fixtureName === 'implicit-codes') {
      expect(coreKeys.size).toBeGreaterThan(0);
    }
  });
});
