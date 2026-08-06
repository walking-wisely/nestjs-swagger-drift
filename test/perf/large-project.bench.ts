/**
 * PLAN §5: "perf pass on a 500-file synthetic project, target under ~10s
 * warm." Run via `npm run test:perf` (excluded from the default `npm test`
 * suite — see `vitest.perf.config.ts`).
 *
 * "Warm" (per the task brief) means: run the full CLI-equivalent pipeline
 * (`ts.Program` construction + `analyzeHandler` over every discovered
 * handler) twice against the SAME generated fixture, discard the first run's
 * timing (this is where TS's own module resolution / OS file-system caches
 * get populated), and assert on the second. `createAnalysisContext` is
 * called fresh each run — a fresh `AnalysisCache` per run, matching how the
 * real CLI invokes it once per process — so what's actually warmed between
 * runs is the OS's file-content cache and V8's JIT, not this tool's own
 * memoization (which is deliberately re-scoped per `ts.Program`, not
 * persisted across runs — see `call-graph.ts`'s module doc).
 *
 * The `10_000`ms budget is intentionally not a hard `expect(ms).toBeLessThan`
 * assertion: this suite runs on arbitrary CI hardware, and a flaky perf gate
 * is worse than a soft one (this project's own "silence over noise" bias,
 * applied to its own test suite). Instead: a generous outer bound
 * (`SOFT_BUDGET_MS`) that fails only on a genuine regression (e.g. an
 * accidentally-removed memoization cache turning this quadratic), and the
 * real measured number always printed to the console either way, which is
 * what actually gets read after a `test:perf` run.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { generatePerfFixture, type PerfFixture } from '../../scripts/gen-perf-fixture.js';
import { createProgramFromTsConfig } from '../../src/cli/program.js';
import { discoverHandlerMethodNodes } from '../../src/cli/discover.js';
import { analyzeHandler, createAnalysisContext, type AnalysisOptions } from '../../src/core/index.js';

const CONTROLLER_COUNT = 500;
// Generous on purpose (see module doc) — the task's own target is ~10s.
const SOFT_BUDGET_MS = 30_000;

const OPTIONS: AnalysisOptions = {
  maxDepth: 2,
  rules: { 'documented-but-unreachable': false, 'unresolvable-status': false },
  treatDefaultAsWildcard: false,
  ignoreStatuses: [],
  checkSuccessResponse: true,
  checkValidationPipe: false,
  checkGuards: true,
};

function runOnce(fixture: PerfFixture): { ms: number; findingCount: number; handlerCount: number } {
  const start = performance.now();
  const outcome = createProgramFromTsConfig(fixture.tsconfigPath);
  if (!outcome.ok) throw new Error('failed to build program for the perf fixture');
  const ctx = createAnalysisContext(outcome.result.program, OPTIONS);
  const nodes = discoverHandlerMethodNodes(outcome.result.program);
  const findings = nodes.flatMap((n) => analyzeHandler(n, ctx));
  const ms = performance.now() - start;
  return { ms, findingCount: findings.length, handlerCount: nodes.length };
}

describe(`analyzing a synthetic ${CONTROLLER_COUNT}-controller project`, () => {
  let fixtureDir: string;
  let fixture: PerfFixture;

  beforeAll(() => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swagger-drift-perf-'));
    fixture = generatePerfFixture(fixtureDir, CONTROLLER_COUNT);
  });

  afterAll(() => {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  it(`completes a warm run in well under the ${SOFT_BUDGET_MS}ms soft budget`, () => {
    const cold = runOnce(fixture);
    console.log(
      `[perf] cold run: ${cold.ms.toFixed(0)}ms, ${cold.handlerCount} handlers, ${cold.findingCount} findings`,
    );

    const warm = runOnce(fixture);
    console.log(
      `[perf] warm run: ${warm.ms.toFixed(0)}ms, ${warm.handlerCount} handlers, ${warm.findingCount} findings`,
    );

    expect(warm.handlerCount).toBeGreaterThan(CONTROLLER_COUNT * 4); // 5 handlers/controller
    expect(warm.findingCount).toBeGreaterThan(0);
    expect(warm.ms).toBeLessThan(SOFT_BUDGET_MS);
  });
});
