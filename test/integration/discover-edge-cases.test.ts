import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { createProgramFromTsConfig } from '../../src/cli/program.js';
import { discoverHandlers } from '../../src/cli/discover.js';
import { sortHandlers } from '../../src/cli/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, '../fixtures/edge-cases');

interface ExpectedRoute {
  httpMethod: string;
  path: string;
  className: string;
  methodName: string;
  unresolvedPath: boolean;
}

describe('discoverHandlers over the edge-cases fixture', () => {
  it('produces exactly the expected route table, including unresolvedPath flags', () => {
    const outcome = createProgramFromTsConfig(join(FIXTURE_DIR, 'tsconfig.json'));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const handlers = sortHandlers(discoverHandlers(outcome.result.program));
    const actual = handlers.map((h) => ({
      httpMethod: h.httpMethod,
      path: h.path,
      className: h.className,
      methodName: h.methodName,
      unresolvedPath: h.unresolvedPath,
    }));

    const expected: ExpectedRoute[] = JSON.parse(
      readFileSync(join(FIXTURE_DIR, 'expected.json'), 'utf8'),
    );

    expect(actual).toEqual(expected);
  });

  it('never emits a route for a static, bodyless-overload, or #private method', () => {
    const outcome = createProgramFromTsConfig(join(FIXTURE_DIR, 'tsconfig.json'));
    if (!outcome.ok) throw new Error('failed to build program');
    const handlers = discoverHandlers(outcome.result.program);

    expect(handlers.some((h) => h.path === '/filter/static')).toBe(false);
    expect(handlers.some((h) => h.path === '/filter/private')).toBe(false);
    // Exactly one /filter/overload route (the implementation), not three.
    expect(handlers.filter((h) => h.path === '/filter/overload')).toHaveLength(1);
  });

  it('documents the known inherited-handler gap: BaseController.inherited is not found on DerivedController', () => {
    const outcome = createProgramFromTsConfig(join(FIXTURE_DIR, 'tsconfig.json'));
    if (!outcome.ok) throw new Error('failed to build program');
    const handlers = discoverHandlers(outcome.result.program);
    // BaseController itself isn't a @Controller, so it contributes nothing...
    expect(handlers.some((h) => h.className === 'BaseController')).toBe(false);
    // ...and DerivedController only reports its own member, not the
    // inherited one a real NestJS app would still register (PLAN §6 gap).
    expect(handlers.some((h) => h.path === '/derived/inherited')).toBe(false);
    expect(handlers.some((h) => h.path === '/derived/own')).toBe(true);
  });
});
