import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type * as ts from 'typescript';
import { createProgramFromTsConfig } from '../../src/cli/program.js';
import { discoverHandlerMethodNodes } from '../../src/cli/discover.js';
import {
  analyzeHandler,
  createAnalysisContext,
  type AnalysisOptions,
  type Finding,
} from '../../src/core/index.js';
import { buildFixPlan, groupEntriesByFile } from '../../src/cli/fix/plan.js';
import { applyFixesToFile } from '../../src/cli/fix/apply.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, '../fixtures/fix-tier2');

// `declarationFile` is always `ts.SourceFile.fileName`, which uses forward
// slashes regardless of OS — `join(FIXTURE_DIR, ...)` alone would produce
// backslashes on Windows and fail these assertions there.
const fixturePath = (rel: string): string => join(FIXTURE_DIR, rel).split('\\').join('/');

function analyzeFixture(): { findings: Finding[]; baseDir: string; checker: ts.TypeChecker } {
  const outcome = createProgramFromTsConfig(join(FIXTURE_DIR, 'tsconfig.json'));
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
  };
  const ctx = createAnalysisContext(program, analysisOptions);
  const findings = discoverHandlerMethodNodes(program).flatMap((node) => analyzeHandler(node, ctx));
  return { findings, baseDir: dirname(configPath), checker: program.getTypeChecker() };
}

describe('Tier 2 autofix (PLAN §10.3) — response type resolution', () => {
  it('resolves a direct class return type and attaches type: on the inserted decorator, with the import added', () => {
    const { findings, baseDir, checker } = analyzeFixture();
    const plan = buildFixPlan(findings, baseDir, checker);
    const entry = plan.entries.find(
      (e) => e.handlerClassName === 'TypedSuccessController' && e.handlerMethodName === 'findOne',
    );
    expect(entry?.responseType).toEqual({
      className: 'WidgetDto',
      isArray: false,
      declarationFile: fixturePath('src/dto.ts'),
    });
    expect(entry?.typeSkippedReason).toBeUndefined();

    const [file, entries] = [...groupEntriesByFile(plan.entries)].find(([f]) =>
      f.endsWith('typed-success.controller.ts'),
    )!;
    const result = applyFixesToFile(file, entries)!;
    expect(result.after).toContain("import { WidgetDto } from './dto.js';");
    expect(result.after).toContain("@ApiOkResponse({ description: 'Ok', type: WidgetDto })");
  });

  it('resolves an array return type with isArray: true', () => {
    const { findings, baseDir, checker } = analyzeFixture();
    const plan = buildFixPlan(findings, baseDir, checker);
    const entry = plan.entries.find(
      (e) => e.handlerClassName === 'TypedArrayController' && e.handlerMethodName === 'findAll',
    );
    expect(entry?.responseType).toEqual({
      className: 'WidgetDto',
      isArray: true,
      declarationFile: fixturePath('src/dto.ts'),
    });

    const [file, entries] = [...groupEntriesByFile(plan.entries)].find(([f]) =>
      f.endsWith('typed-array.controller.ts'),
    )!;
    const result = applyFixesToFile(file, entries)!;
    expect(result.after).toContain(
      "@ApiOkResponse({ description: 'Ok', type: WidgetDto, isArray: true })",
    );
  });

  it('a same-file DTO gets type: without any import being added or touched', () => {
    const { findings, baseDir, checker } = analyzeFixture();
    const plan = buildFixPlan(findings, baseDir, checker);
    const entry = plan.entries.find((e) => e.handlerClassName === 'SameFileDtoController')!;
    expect(entry.responseType).toEqual({
      className: 'LocalDto',
      isArray: false,
      declarationFile: fixturePath('src/same-file-dto.controller.ts'),
    });

    const [file, entries] = [...groupEntriesByFile(plan.entries)].find(([f]) =>
      f.endsWith('same-file-dto.controller.ts'),
    )!;
    const result = applyFixesToFile(file, entries)!;
    expect(result.after).toContain(
      "@ApiCreatedResponse({ description: 'Created', type: LocalDto })",
    );
    // No new import line was added — the file's only import from
    // '@nestjs/swagger' is the pre-existing `ApiProperty` one.
    expect(result.after.match(/from '@nestjs\/swagger'/g)?.length).toBe(1);
  });

  it('reuses an ALREADY-imported DTO binding instead of adding a second import', () => {
    const { findings, baseDir, checker } = analyzeFixture();
    const plan = buildFixPlan(findings, baseDir, checker);
    const [file, entries] = [...groupEntriesByFile(plan.entries)].find(([f]) =>
      f.endsWith('existing-dto-import.controller.ts'),
    )!;
    const result = applyFixesToFile(file, entries)!;
    expect(result.after.match(/import \{ WidgetDto \} from '\.\/dto\.js';/g)?.length).toBe(1);
    expect(result.after).toContain(
      "@ApiCreatedResponse({ description: 'Created', type: WidgetDto })",
    );
  });

  it('gate 1 (not a class): a union resolving to an interface falls back to the untyped stub', () => {
    const { findings, baseDir, checker } = analyzeFixture();
    const plan = buildFixPlan(findings, baseDir, checker);
    const entry = plan.entries.find((e) => e.handlerClassName === 'InterfaceReturnController')!;
    expect(entry.responseType).toBeUndefined();
    expect(entry.typeSkippedReason).toBeDefined();

    const [file, entries] = [...groupEntriesByFile(plan.entries)].find(([f]) =>
      f.endsWith('interface-return.controller.ts'),
    )!;
    const result = applyFixesToFile(file, entries)!;
    // Untyped stub, no `type:`/`isArray:` -- and no NEW import was added for
    // the gate-failed type (the pre-existing `import type { WidgetPage }` is
    // untouched, but nothing else references it).
    expect(result.after).toContain("@ApiOkResponse({ description: 'Ok' })");
    expect(result.after.match(/from '\.\/dto\.js'/g)?.length).toBe(1);
  });

  it('gate 2 (no @ApiProperty): a plain class falls back to the untyped stub', () => {
    const { findings, baseDir, checker } = analyzeFixture();
    const plan = buildFixPlan(findings, baseDir, checker);
    const entry = plan.entries.find((e) => e.handlerClassName === 'NoApiPropertyController')!;
    expect(entry.responseType).toBeUndefined();
    expect(entry.typeSkippedReason).toContain('no @ApiProperty()');

    const [file, entries] = [...groupEntriesByFile(plan.entries)].find(([f]) =>
      f.endsWith('no-api-property.controller.ts'),
    )!;
    const result = applyFixesToFile(file, entries)!;
    expect(result.after).toContain("@ApiOkResponse({ description: 'Ok' })");
    expect(result.after.match(/from '\.\/dto\.js'/g)?.length).toBe(1);
  });

  it('omitting the checker falls back to Tier 1 behavior for every entry (no responseType, no typeSkippedReason)', () => {
    const { findings, baseDir } = analyzeFixture();
    const plan = buildFixPlan(findings, baseDir);
    expect(plan.entries.length).toBeGreaterThan(0);
    for (const entry of plan.entries) {
      expect(entry.responseType).toBeUndefined();
      expect(entry.typeSkippedReason).toBeUndefined();
    }
  });
});
