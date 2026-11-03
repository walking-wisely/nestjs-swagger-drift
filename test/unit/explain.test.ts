import { describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import { traceSource } from '../../src/core/explain.js';
import type { StatusSource } from '../../src/core/types.js';
import { createInMemoryProgram } from '../helpers/in-memory-program.js';

function throwSource(code: string): StatusSource {
  const program = createInMemoryProgram({ 'main.ts': code }, ['main.ts'], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  });
  const sourceFile = program.getSourceFile('main.ts')!;
  let found: ts.ThrowStatement | undefined;
  ts.forEachChild(sourceFile, function visit(node) {
    if (ts.isThrowStatement(node)) found = node;
    ts.forEachChild(node, visit);
  });
  if (!found) throw new Error('no throw in fixture');
  return { kind: 'throw', node: found, exception: 'Error' };
}

describe('traceSource', () => {
  it('reports a guard that reads a parameter of the enclosing function', () => {
    const trace = traceSource(
      throwSource(
        `function f(strict?: boolean) { if (strict) { throw new Error('x'); } return 1; }`,
      ),
    )!;
    expect(trace.guards).toHaveLength(1);
    expect(trace.guards[0]).toMatchObject({
      kind: 'if-then',
      condition: 'strict',
      parameters: ['strict'],
    });
    expect(trace.guards[0]!.assessment).toContain('not a known constant');
  });

  it('reports an unconditional throw with no guards', () => {
    expect(traceSource(throwSource(`function f() { throw new Error('x'); }`))!.guards).toEqual([]);
  });

  it('lists nested guards outermost first and marks the else branch', () => {
    const trace = traceSource(
      throwSource(
        `function f(a: boolean, b: number) { if (a) { if (b > 1) { return 1; } else { throw new Error('x'); } } return 2; }`,
      ),
    )!;
    expect(trace.guards.map((g) => [g.kind, g.condition])).toEqual([
      ['if-then', 'a'],
      ['if-else', 'b > 1'],
    ]);
  });

  it('does not treat a property name as a parameter reference', () => {
    const trace = traceSource(
      throwSource(
        `function f(ok: boolean, o: { ok: boolean }) { if (o.ok) { throw new Error('x'); } }`,
      ),
    )!;
    expect(trace.guards[0]!.parameters).toEqual(['o']);
  });

  it('returns nothing for an implicit source', () => {
    const node = ts.factory.createIdentifier('x');
    expect(traceSource({ kind: 'implicit', node, reason: 'success' })).toBeUndefined();
  });

  it('reports what the last hop passed for the parameters the guards read', () => {
    const code = `
      function f(strict?: boolean, other?: number) { if (strict) { throw new Error('x'); } }
      function caller(flag: boolean) { f(flag); }
    `;
    const program = createInMemoryProgram({ 'main.ts': code }, ['main.ts'], {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
    });
    const file = program.getSourceFile('main.ts')!;
    let throwNode: ts.Node | undefined;
    let callNode: ts.Node | undefined;
    ts.forEachChild(file, function visit(node) {
      if (ts.isThrowStatement(node)) throwNode = node;
      if (ts.isCallExpression(node)) callNode = node;
      ts.forEachChild(node, visit);
    });
    const trace = traceSource({
      kind: 'service-throw',
      node: throwNode!,
      exception: 'Error',
      via: [{ name: 'f', node: callNode! }],
    })!;
    expect(trace.finalArguments).toEqual([{ parameter: 'strict', argument: 'flag' }]);
  });
});
