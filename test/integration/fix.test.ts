import { describe, expect, it, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createProgramFromTsConfig } from '../../src/cli/program.js';
import { discoverHandlerMethodNodes } from '../../src/cli/discover.js';
import { analyzeHandler, createAnalysisContext, type AnalysisOptions, type Finding } from '../../src/core/index.js';
import { buildFixPlan, groupEntriesByFile } from '../../src/cli/fix/plan.js';
import { applyFixesToFile } from '../../src/cli/fix/apply.js';
import { formatFileDiff } from '../../src/cli/fix/format-diff.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, '../fixtures/fix-tier1');
const IMPLICIT_CODES_DIR = join(__dirname, '../fixtures/implicit-codes');

function analyzeFixture(fixtureDir: string, options: Partial<AnalysisOptions> = {}): {
  findings: Finding[];
  baseDir: string;
} {
  const outcome = createProgramFromTsConfig(join(fixtureDir, 'tsconfig.json'));
  if (!outcome.ok) throw new Error('fixture failed to build a Program');
  const { program, configPath } = outcome.result;
  const analysisOptions: AnalysisOptions = {
    maxDepth: 2,
    rules: { 'documented-but-unreachable': false, 'unresolvable-status': false },
    treatDefaultAsWildcard: false,
    ignoreStatuses: [],
    checkSuccessResponse: true,
    checkValidationPipe: false,
    checkGuards: false,
    ...options,
  };
  const ctx = createAnalysisContext(program, analysisOptions);
  const findings = discoverHandlerMethodNodes(program).flatMap((node) => analyzeHandler(node, ctx));
  return { findings, baseDir: dirname(configPath) };
}

describe('buildFixPlan', () => {
  it('produces a fixable entry per deterministic undocumented-status finding, with the right decorator shape', () => {
    const { findings, baseDir } = analyzeFixture(FIXTURE_DIR);
    const plan = buildFixPlan(findings, baseDir);

    const byHandlerStatus = new Map(
      plan.entries.map((e) => [`${e.handlerClassName}.${e.handlerMethodName}:${e.status}`, e]),
    );

    // Direct throw, built-in exception -> shorthand decorator.
    const fresh = byHandlerStatus.get('FreshImportController.findOne:404');
    expect(fresh).toMatchObject({ decoratorName: 'ApiNotFoundResponse', isShorthand: true });

    // service-throw, one hop -> shorthand decorator, same as a direct throw.
    const existing = byHandlerStatus.get('ExistingImportController.update:409');
    expect(existing).toMatchObject({ decoratorName: 'ApiConflictResponse', isShorthand: true });

    // A status with no HttpStatus member -> generic ApiResponse fallback.
    const custom = byHandlerStatus.get('CustomStatusController.list:431');
    expect(custom).toMatchObject({ decoratorName: 'ApiResponse', isShorthand: false, description: 'Status 431' });

    // Implicit success on a POST defaults to 201, and is fixable.
    const success = byHandlerStatus.get('MultiStatusController.create:201');
    expect(success).toMatchObject({ decoratorName: 'ApiCreatedResponse', isShorthand: true });

    // Same handler, a second fixable finding (its own direct throw).
    const conflict = byHandlerStatus.get('MultiStatusController.create:409');
    expect(conflict).toMatchObject({ decoratorName: 'ApiConflictResponse', isShorthand: true });
  });

  it('skips a finding sourced ONLY from an opt-in implicit check (checkGuards)', () => {
    const { findings, baseDir } = analyzeFixture(IMPLICIT_CODES_DIR, { checkGuards: true });
    const plan = buildFixPlan(findings, baseDir);

    const guardOnly401 = plan.skipped.find(
      (s) => s.finding.handler.className === 'GuardsController' && s.finding.status === 401,
    );
    expect(guardOnly401).toBeDefined();
    expect(plan.entries.some((e) => e.handlerClassName === 'GuardsController' && e.status === 401)).toBe(false);

    // The SAME handler's implicit success (200) is still independently fixable.
    expect(plan.entries.some((e) => e.handlerClassName === 'GuardsController' && e.status === 200)).toBe(true);
  });
});

describe('applyFixesToFile (dry run — no writes)', () => {
  it('inserts a fresh @nestjs/swagger import plus the shorthand decorator', () => {
    const { findings, baseDir } = analyzeFixture(FIXTURE_DIR);
    const plan = buildFixPlan(findings, baseDir);
    const [file, entries] = [...groupEntriesByFile(plan.entries)].find(([f]) =>
      f.endsWith('fresh-import.controller.ts'),
    )!;

    // Two fixable findings on the same GET handler: the direct throw (404)
    // and the implicit success default (200) — both land in one import.
    expect(entries.map((e) => e.status).sort()).toEqual([200, 404]);

    const result = applyFixesToFile(file, entries);
    expect(result).toBeDefined();
    expect(result!.after).toContain(
      "import { ApiNotFoundResponse, ApiOkResponse } from '@nestjs/swagger';",
    );
    expect(result!.after).toContain("@ApiNotFoundResponse({ description: 'Not Found' })");
    expect(result!.after).toContain("@ApiOkResponse({ description: 'Ok' })");
    expect(result!.before).not.toContain('ApiNotFoundResponse');

    // Diff formatting produces a real unified diff (added lines only).
    const diff = formatFileDiff(result!, baseDir);
    expect(diff).toContain('+import { ApiNotFoundResponse, ApiOkResponse }');
    expect(diff).toContain("+  @ApiNotFoundResponse({ description: 'Not Found' })");
    expect(diff.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---')).length).toBe(0);
  });

  it('adds a named import to an EXISTING @nestjs/swagger import rather than a second declaration', () => {
    const { findings, baseDir } = analyzeFixture(FIXTURE_DIR);
    const plan = buildFixPlan(findings, baseDir);
    const [file, entries] = [...groupEntriesByFile(plan.entries)].find(([f]) =>
      f.endsWith('existing-import.controller.ts'),
    )!;

    // Also picks up the handler's own implicit success default (POST -> 201).
    expect(entries.map((e) => e.status).sort()).toEqual([201, 409]);

    const result = applyFixesToFile(file, entries)!;
    expect(result.after).toContain(
      "import { ApiTags, ApiConflictResponse, ApiCreatedResponse } from '@nestjs/swagger';",
    );
    expect(result.after.match(/from '@nestjs\/swagger'/g)?.length).toBe(1);
    expect(result.after).toContain("@ApiConflictResponse({ description: 'Conflict' })");
    expect(result.after).toContain("@ApiCreatedResponse({ description: 'Created' })");
  });

  it('matches a tab-indented file\'s own style and preserves a trailing comment on the existing decorator', () => {
    const { findings, baseDir } = analyzeFixture(FIXTURE_DIR);
    const plan = buildFixPlan(findings, baseDir);
    const [file, entries] = [...groupEntriesByFile(plan.entries)].find(([f]) =>
      f.endsWith('tab-indented.controller.ts'),
    )!;

    const result = applyFixesToFile(file, entries)!;
    const lines = result.after.split('\n');

    // New decorator indented with a tab, matching the file, not two spaces.
    const notFoundLine = lines.find((l) => l.trimStart().startsWith('@ApiNotFoundResponse'));
    expect(notFoundLine).toBe("\t@ApiNotFoundResponse({ description: 'Not Found' })");

    // The trailing comment stays on `@Get`, not reassociated onto the new decorator.
    expect(result.after).toContain("@Get(':id') // fetch one");
    expect(result.after).not.toContain("ApiNotFoundResponse({ description: 'Not Found' }) // fetch one");
  });

  it('falls back to a generic @ApiResponse({ status }) for a status with no shorthand', () => {
    const { findings, baseDir } = analyzeFixture(FIXTURE_DIR);
    const plan = buildFixPlan(findings, baseDir);
    const [file, entries] = [...groupEntriesByFile(plan.entries)].find(([f]) =>
      f.endsWith('custom-status.controller.ts'),
    )!;

    // Also picks up the handler's own implicit success default (GET -> 200).
    expect(entries.map((e) => e.status).sort()).toEqual([200, 431]);

    const result = applyFixesToFile(file, entries)!;
    expect(result.after).toContain("import { ApiOkResponse, ApiResponse } from '@nestjs/swagger';");
    expect(result.after).toContain("@ApiResponse({ status: 431, description: 'Status 431' })");
    expect(result.after).toContain("@ApiOkResponse({ description: 'Ok' })");
  });

  it('inserts multiple decorators on the same method without corrupting it', () => {
    const { findings, baseDir } = analyzeFixture(FIXTURE_DIR);
    const plan = buildFixPlan(findings, baseDir);
    const [file, entries] = [...groupEntriesByFile(plan.entries)].find(([f]) =>
      f.endsWith('multi-status.controller.ts'),
    )!;
    expect(entries).toHaveLength(2);

    const result = applyFixesToFile(file, entries)!;
    expect(result.after).toContain('@ApiCreatedResponse');
    expect(result.after).toContain('@ApiConflictResponse');
    expect(result.after).toContain('create(flag: boolean): string {');

    // The mutated file must still be syntactically sound enough to re-parse
    // and re-discover the exact same handler shape — a cheap proxy for "we
    // didn't corrupt the AST", independent of a full tsc invocation.
    const reprogrammed = fs.mkdtempSync(path.join(os.tmpdir(), 'swagger-drift-fix-reparse-'));
    try {
      fs.cpSync(FIXTURE_DIR, reprogrammed, { recursive: true });
      fs.writeFileSync(join(reprogrammed, 'src/multi-status.controller.ts'), result.after);
      const { findings: after } = analyzeFixture(reprogrammed);
      const stillUndocumented = after.filter(
        (f): f is Extract<Finding, { rule: 'undocumented-status' }> =>
          f.rule === 'undocumented-status' && f.handler.className === 'MultiStatusController',
      );
      expect(stillUndocumented.some((f) => f.status === 409)).toBe(false);
      expect(stillUndocumented.some((f) => f.status === 201)).toBe(false);
    } finally {
      fs.rmSync(reprogrammed, { recursive: true, force: true });
    }
  });
});

describe('applyFixesToFile — existing @nestjs/swagger import edge cases', () => {
  /** Re-parses `after` in an isolated copy of the fixture dir and asserts the 404 finding for `className` is now resolved — a cheap proxy for "the emitted file is syntactically valid and semantically correct", same pattern as the "inserts multiple decorators" test above. */
  function expect404Resolved(sourceFileName: string, className: string, after: string): void {
    const reprogrammed = fs.mkdtempSync(path.join(os.tmpdir(), 'swagger-drift-fix-reparse-'));
    try {
      fs.cpSync(FIXTURE_DIR, reprogrammed, { recursive: true });
      fs.writeFileSync(join(reprogrammed, 'src', sourceFileName), after);
      const { findings } = analyzeFixture(reprogrammed);
      const stillUndocumented = findings.filter(
        (f): f is Extract<Finding, { rule: 'undocumented-status' }> =>
          f.rule === 'undocumented-status' && f.handler.className === className,
      );
      expect(stillUndocumented.some((f) => f.status === 404)).toBe(false);
    } finally {
      fs.rmSync(reprogrammed, { recursive: true, force: true });
    }
  }

  it('an ALIASED existing import (`ApiResponse as Res`) gets a second, plain-named specifier — not silently treated as already covering the plain name', () => {
    const { findings, baseDir } = analyzeFixture(FIXTURE_DIR);
    const plan = buildFixPlan(findings, baseDir);
    const [file, entries] = [...groupEntriesByFile(plan.entries)].find(([f]) =>
      f.endsWith('aliased-import.controller.ts'),
    )!;

    const result = applyFixesToFile(file, entries)!;

    // The alias stays untouched, and second, unaliased specifiers for the
    // names autofix actually emits bare (`ApiNotFoundResponse` for the
    // direct throw, `ApiOkResponse` for the handler's own implicit-success
    // default) are added to the SAME declaration — not a second
    // `from '@nestjs/swagger'` line.
    expect(result.after).toContain(
      "import { ApiResponse as Res, ApiNotFoundResponse, ApiOkResponse } from '@nestjs/swagger';",
    );
    expect(result.after.match(/^import .* from '@nestjs\/swagger';$/gm)?.length).toBe(1);
    expect(result.after).toContain("@ApiNotFoundResponse({ description: 'Not Found' })");
    // The hand-written aliased usage is untouched.
    expect(result.after).toContain("@Res({ description: 'existing, hand-written' })");

    // This also proves the emitted bare `@ApiNotFoundResponse` call
    // actually has a binding in scope (it would NOT, pre-fix: the alias
    // check wrongly treated the plain name as already imported, so no
    // import for it was ever added).
    expect404Resolved('aliased-import.controller.ts', 'AliasedImportController', result.after);
  });

  it('a TYPE-ONLY existing import (`import type { ... }`) is left alone; a separate value import is added', () => {
    const { findings, baseDir } = analyzeFixture(FIXTURE_DIR);
    const plan = buildFixPlan(findings, baseDir);
    const [file, entries] = [...groupEntriesByFile(plan.entries)].find(([f]) =>
      f.endsWith('type-only-import.controller.ts'),
    )!;

    const result = applyFixesToFile(file, entries)!;

    // The type-only import is untouched — appending a value specifier to it
    // would be a compile error (TS1361) — and a separate value import
    // declaration carries the new names instead.
    expect(result.after).toContain("import type { ApiResponseOptions } from '@nestjs/swagger';");
    expect(result.after).toContain("import { ApiNotFoundResponse, ApiOkResponse } from '@nestjs/swagger';");
    expect(result.after.match(/^import .* from '@nestjs\/swagger';$/gm)?.length).toBe(2);
    expect(result.after).toContain("@ApiNotFoundResponse({ description: 'Not Found' })");

    expect404Resolved('type-only-import.controller.ts', 'TypeOnlyImportController', result.after);
  });

  it('a NAMESPACE existing import (`import * as swagger from ...`) does not crash `addNamedImports`; a separate named import is added', () => {
    const { findings, baseDir } = analyzeFixture(FIXTURE_DIR);
    const plan = buildFixPlan(findings, baseDir);
    const [file, entries] = [...groupEntriesByFile(plan.entries)].find(([f]) =>
      f.endsWith('namespace-import.controller.ts'),
    )!;

    expect(() => applyFixesToFile(file, entries)).not.toThrow();
    const result = applyFixesToFile(file, entries)!;

    expect(result.after).toContain("import * as swagger from '@nestjs/swagger';");
    expect(result.after).toContain("import { ApiNotFoundResponse, ApiOkResponse } from '@nestjs/swagger';");
    expect(result.after.match(/^import .* from '@nestjs\/swagger';$/gm)?.length).toBe(2);
    expect(result.after).toContain("@ApiNotFoundResponse({ description: 'Not Found' })");
    // The hand-written namespace usage is untouched.
    expect(result.after).toContain("@swagger.ApiTags('namespace')");

    expect404Resolved('namespace-import.controller.ts', 'NamespaceImportController', result.after);
  });
});

describe('decoratorAlreadyPresent (issue 6 — no false positive from substring matching)', () => {
  it('does not treat a nested/free-text "status: 404" elsewhere in the argument as the decorator already being present', () => {
    const { findings, baseDir } = analyzeFixture(FIXTURE_DIR);
    const plan = buildFixPlan(findings, baseDir);
    const [file, entries] = [...groupEntriesByFile(plan.entries)].find(([f]) =>
      f.endsWith('substring-trap.controller.ts'),
    )!;

    // The 404 finding (direct throw) is still fixable — the existing
    // @ApiResponse only documents 200; "status: 404" merely appears inside
    // its schema example and description text.
    expect(entries.some((e) => e.status === 404)).toBe(true);

    const result = applyFixesToFile(file, entries)!;
    expect(result.applied.some((e) => e.status === 404)).toBe(true);
    expect(result.notApplied).toEqual([]);
    expect(result.after).toContain("@ApiNotFoundResponse({ description: 'Not Found' })");
    // The original decorator (and its trap text) is untouched, not replaced.
    expect(result.after).toContain('{ status: 404 }');
    expect(result.after).toContain("status: 200");
  });
});

describe('FileFixResult.notApplied surfacing (issue 7)', () => {
  it('reports a skipped-as-already-present entry via notApplied with a reason, instead of silently dropping it', () => {
    // `fresh-import.controller.ts`'s handler yields two genuine entries
    // (404, 200). A duplicated 404 entry simulates the defensive case
    // `decoratorAlreadyPresent`'s true-branch guards against — e.g. a stale
    // re-plan against a file a concurrent edit already touched — without
    // depending on `documented.ts` ever re-finding a status it now
    // recognizes as documented (which would just never plan it again,
    // never reaching `applyFixesToFile` at all).
    const { findings, baseDir } = analyzeFixture(FIXTURE_DIR);
    const plan = buildFixPlan(findings, baseDir);
    const [file, entries] = [...groupEntriesByFile(plan.entries)].find(([f]) =>
      f.endsWith('fresh-import.controller.ts'),
    )!;
    expect(entries.map((e) => e.status).sort()).toEqual([200, 404]);

    const notFoundEntry = entries.find((e) => e.status === 404)!;
    const withDuplicate = [...entries, notFoundEntry];

    const result = applyFixesToFile(file, withDuplicate)!;
    expect(result.applied.map((e) => e.status).sort()).toEqual([200, 404]);
    expect(result.notApplied).toEqual([{ entry: notFoundEntry, reason: 'decorator already present' }]);
    // Only ONE @ApiNotFoundResponse actually landed in the output, not two.
    expect(result.after.match(/@ApiNotFoundResponse/g)?.length).toBe(1);
  });

  it("reports an unlocatable entry (stale methodStartPos) via notApplied", () => {
    const { findings, baseDir } = analyzeFixture(FIXTURE_DIR);
    const plan = buildFixPlan(findings, baseDir);
    const [file, entries] = [...groupEntriesByFile(plan.entries)].find(([f]) =>
      f.endsWith('fresh-import.controller.ts'),
    )!;
    const staleEntries = entries.map((e) => ({ ...e, methodStartPos: 999_999 }));

    const result = applyFixesToFile(file, staleEntries);
    expect(result).toBeDefined();
    expect(result!.applied).toEqual([]);
    expect(result!.notApplied).toHaveLength(staleEntries.length);
    for (const { reason } of result!.notApplied) {
      expect(reason).toBe('method not found (handler moved or removed since analysis)');
    }
    // Nothing was actually changed.
    expect(result!.after).toBe(result!.before);
  });
});

describe('--fix write mode + idempotency', () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('re-running --fix against its own output is a no-op', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swagger-drift-fix-idempotent-'));
    tempDirs.push(tmp);
    fs.cpSync(FIXTURE_DIR, tmp, { recursive: true });

    // First pass: write real fixes.
    const first = analyzeFixture(tmp);
    const firstPlan = buildFixPlan(first.findings, first.baseDir);
    expect(firstPlan.entries.length).toBeGreaterThan(0);
    for (const [file, entries] of groupEntriesByFile(firstPlan.entries)) {
      const result = applyFixesToFile(file, entries);
      if (result) fs.writeFileSync(result.file, result.after);
    }

    // Re-analyze the now-fixed tree: every fixable finding is gone.
    const second = analyzeFixture(tmp);
    const secondPlan = buildFixPlan(second.findings, second.baseDir);
    expect(secondPlan.entries).toHaveLength(0);

    // Applying the (now-empty) plan again touches nothing.
    for (const [file, entries] of groupEntriesByFile(secondPlan.entries)) {
      expect(applyFixesToFile(file, entries)).toBeUndefined();
    }
  });
});
