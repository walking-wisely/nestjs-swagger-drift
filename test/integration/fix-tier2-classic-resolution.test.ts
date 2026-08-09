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
const FIXTURE_DIR = join(__dirname, '../fixtures/fix-tier2-classic-resolution');

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

// Two real bugs found running Tier 2 autofix against a live
// `"moduleResolution": "node"` repo (Ever Gauzy, 2026-08-08): fixtures here
// reproduce both under a project that mirrors that resolution mode (unlike
// `fix-tier2`'s own fixture project, which uses `nodenext` throughout and
// so never exercised either).
describe('Tier 2 autofix — classic (non-nodenext) module resolution', () => {
  it('reuses an existing extensionless relative import instead of appending .js and duplicating it', () => {
    const { findings, baseDir, checker } = analyzeFixture();
    const plan = buildFixPlan(findings, baseDir, checker);
    const [file, entries] = [...groupEntriesByFile(plan.entries)].find(([f]) =>
      f.endsWith('reused-import.controller.ts'),
    )!;
    const result = applyFixesToFile(file, entries)!;

    // Exactly the ORIGINAL extensionless import, reused — no second,
    // `.js`-suffixed import of the same class under a colliding alias.
    const importLines = result.after.split('\n').filter((line) => line.startsWith('import'));
    expect(importLines.filter((line) => line.includes("from './dto'")).length).toBe(1);
    expect(importLines.some((line) => line.includes('.js'))).toBe(false);
    expect(importLines.some((line) => line.includes('WidgetDto2'))).toBe(false);
    expect(result.after).toContain(
      "@ApiOkResponse({ description: 'Ok', type: WidgetDto })",
    );
  });

  it("a brand-new cross-file import omits '.js' when the file's own relative imports don't use it", () => {
    const { findings, baseDir, checker } = analyzeFixture();
    const plan = buildFixPlan(findings, baseDir, checker);
    const [file, entries] = [...groupEntriesByFile(plan.entries)].find(([f]) =>
      f.endsWith('position-drift.controller.ts'),
    )!;
    const result = applyFixesToFile(file, entries)!;

    expect(result.after).toContain("import { GadgetDto } from './dto';");
    expect(result.after).not.toContain('./dto.js');
  });

  it('an earlier (lower-position) finding is still applied after a later finding triggers a new top-of-file import', () => {
    const { findings, baseDir, checker } = analyzeFixture();
    const plan = buildFixPlan(findings, baseDir, checker);
    const [file, entries] = [...groupEntriesByFile(plan.entries)].find(([f]) =>
      f.endsWith('position-drift.controller.ts'),
    )!;

    // Sanity: the fixture actually exercises both an import-triggering
    // entry (findGadget) and a plain entry with a strictly lower original
    // position (findFirst) — otherwise this test would pass vacuously.
    const findFirstEntries = entries.filter((e) => e.handlerMethodName === 'findFirst');
    const findGadgetEntries = entries.filter((e) => e.handlerMethodName === 'findGadget');
    expect(findFirstEntries.length).toBeGreaterThan(0);
    expect(findGadgetEntries.length).toBeGreaterThan(0);
    expect(Math.min(...findFirstEntries.map((e) => e.methodStartPos))).toBeLessThan(
      Math.min(...findGadgetEntries.map((e) => e.methodStartPos)),
    );

    const result = applyFixesToFile(file, entries)!;
    expect(result.notApplied).toEqual([]);
    expect(result.applied.length).toBe(entries.length);
    // findFirst's own finding (a 404 from the direct throw) actually landed
    // on its own method — still above `findFirst`'s `@Get`, and before
    // `findGadget`'s `@Get`, not silently dropped as "moved or removed" nor
    // misattributed to the wrong handler.
    const notFoundIdx = result.after.indexOf("@ApiNotFoundResponse({ description: 'Not Found' })");
    const getFirstIdx = result.after.indexOf("@Get('first')");
    const getGadgetIdx = result.after.indexOf("@Get('gadget')");
    expect(notFoundIdx).toBeGreaterThan(-1);
    expect(notFoundIdx).toBeLessThan(getFirstIdx);
    expect(getFirstIdx).toBeLessThan(getGadgetIdx);
  });
});
