import { describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import { buildFixPlan } from '../../src/cli/fix/plan.js';
import type { Finding, StatusSource } from '../../src/core/types.js';
import { createInMemoryProgram } from '../helpers/in-memory-program.js';

function throwSource(code: string): StatusSource {
  const program = createInMemoryProgram({ 'main.ts': code }, ['main.ts'], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  });
  let node: ts.ThrowStatement | undefined;
  ts.forEachChild(program.getSourceFile('main.ts')!, function visit(child) {
    if (ts.isThrowStatement(child)) node = child;
    ts.forEachChild(child, visit);
  });
  return { kind: 'service-throw', node: node!, exception: 'NotFoundException', via: [] };
}

function finding(source: StatusSource): Finding {
  return {
    rule: 'undocumented-status',
    status: 404,
    sources: [source],
    node: source.node,
    handler: { className: 'C', methodName: 'm', node: source.node },
  } as unknown as Finding;
}

describe('buildFixPlan confidence', () => {
  it('skips a finding reached only through a catch block', () => {
    const source = throwSource(
      `declare function g(): void; function f() { try { g(); } catch (e) { throw new Error('x'); } }`,
    );
    const plan = buildFixPlan([finding(source)], '/');
    expect(plan.entries).toHaveLength(0);
    expect(plan.skipped[0]?.reason).toContain('low confidence');
  });

  it('plans a finding with an unconditional throw', () => {
    const plan = buildFixPlan(
      [finding(throwSource(`function f() { throw new Error('x'); }`))],
      '/',
    );
    expect(plan.entries).toHaveLength(1);
  });
});
