import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { createProgramFromTsConfig } from '../../src/cli/program.js';
import { collectDiscoveryWarnings, discoverHandlers } from '../../src/cli/discover.js';
import { sortHandlers } from '../../src/cli/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, '../fixtures/basic');

interface ExpectedRoute {
  httpMethod: string;
  path: string;
  className: string;
  methodName: string;
}

describe('discoverHandlers over the basic fixture', () => {
  it('produces exactly the expected route table (Phase 1 exit criterion)', () => {
    const outcome = createProgramFromTsConfig(join(FIXTURE_DIR, 'tsconfig.json'));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const handlers = discoverHandlers(outcome.result.program);
    const sorted = sortHandlers(handlers);

    const actual = sorted.map((h) => ({
      httpMethod: h.httpMethod,
      path: h.path,
      className: h.className,
      methodName: h.methodName,
    }));

    const expected: ExpectedRoute[] = JSON.parse(
      readFileSync(join(FIXTURE_DIR, 'expected.json'), 'utf8'),
    );

    expect(actual).toEqual(expected);
  });

  it('every route in the fully-literal basic fixture is fully resolved', () => {
    const outcome = createProgramFromTsConfig(join(FIXTURE_DIR, 'tsconfig.json'));
    if (!outcome.ok) throw new Error('failed to build program');
    const handlers = discoverHandlers(outcome.result.program);
    expect(handlers.every((h) => h.unresolvedPath === false)).toBe(true);
  });

  it('ignores the imposter controller entirely', () => {
    const outcome = createProgramFromTsConfig(join(FIXTURE_DIR, 'tsconfig.json'));
    if (!outcome.ok) throw new Error('failed to build program');
    const handlers = discoverHandlers(outcome.result.program);
    expect(handlers.some((h) => h.className === 'FakeController')).toBe(false);
  });

  it('ignores the non-controller service class', () => {
    const outcome = createProgramFromTsConfig(join(FIXTURE_DIR, 'tsconfig.json'));
    if (!outcome.ok) throw new Error('failed to build program');
    const handlers = discoverHandlers(outcome.result.program);
    expect(handlers.some((h) => h.className === 'UsersService')).toBe(false);
  });

  it('warns about the rejected imposter Controller decorator, not silence', () => {
    const outcome = createProgramFromTsConfig(join(FIXTURE_DIR, 'tsconfig.json'));
    if (!outcome.ok) throw new Error('failed to build program');
    const warnings = collectDiscoveryWarnings(outcome.result.program);
    const rejected = warnings.filter((w) => w.kind === 'rejected-controller-like');
    expect(rejected.some((w) => w.message.includes('FakeController'))).toBe(true);
    // The basic fixture's @nestjs/common resolves fine (ambient stub) — no
    // unresolved-module warning should ever accompany a real rejection.
    expect(warnings.some((w) => w.kind === 'unresolved-module')).toBe(false);
  });
});
