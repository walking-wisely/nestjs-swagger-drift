import { describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import { collectDirectThrows } from '../../src/core/thrown.js';
import { createInMemoryProgram } from '../helpers/in-memory-program.js';

function findMethod(source: string, methodName: string): ts.MethodDeclaration {
  const program = createInMemoryProgram({ 'main.ts': source }, ['main.ts'], {
    target: ts.ScriptTarget.ES2022,
    experimentalDecorators: true,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  });
  const sourceFile = program.getSourceFile('main.ts');
  if (!sourceFile) throw new Error('missing main.ts');

  let found: ts.MethodDeclaration | undefined;
  ts.forEachChild(sourceFile, function visit(node) {
    if (
      ts.isMethodDeclaration(node) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      node.name.text === methodName
    ) {
      found = node;
    }
    ts.forEachChild(node, visit);
  });
  if (!found) throw new Error(`method ${methodName} not found`);
  return found;
}

describe('collectDirectThrows', () => {
  it('collects a direct throw', () => {
    const method = findMethod(`class C { m() { throw new Error('x'); } }`, 'm');
    expect(collectDirectThrows(method)).toHaveLength(1);
  });

  it('collects a conditional throw', () => {
    const method = findMethod(
      `class C { m(x: boolean) { if (x) { throw new Error('x'); } return 1; } }`,
      'm',
    );
    expect(collectDirectThrows(method)).toHaveLength(1);
  });

  it('collects a throw inside a catch block (rethrow)', () => {
    const method = findMethod(
      `class C { m() { try { doThing(); } catch (err) { throw err; } } }`,
      'm',
    );
    expect(collectDirectThrows(method)).toHaveLength(1);
  });

  it('collects multiple throws', () => {
    const method = findMethod(
      `class C { m(x: boolean) { if (x) { throw new Error('a'); } throw new Error('b'); } }`,
      'm',
    );
    expect(collectDirectThrows(method)).toHaveLength(2);
  });

  it('does NOT collect a throw inside an arrow-function callback', () => {
    const method = findMethod(
      `class C { m() { [1,2].forEach(x => { throw new Error('x'); }); } }`,
      'm',
    );
    expect(collectDirectThrows(method)).toHaveLength(0);
  });

  it('does NOT collect a throw inside a nested function expression', () => {
    const method = findMethod(
      `class C { m() { const f = function () { throw new Error('x'); }; f(); } }`,
      'm',
    );
    expect(collectDirectThrows(method)).toHaveLength(0);
  });

  it('does NOT collect a throw inside a try block that has a catch (swallowed)', () => {
    const method = findMethod(
      `class C { m() { try { throw new Error('x'); } catch { return null; } } }`,
      'm',
    );
    expect(collectDirectThrows(method)).toHaveLength(0);
  });

  it('collects a throw inside the catch when the try itself also throws (remap shape)', () => {
    const method = findMethod(
      `class C { m() { try { throw new Error('a'); } catch { throw new Error('b'); } } }`,
      'm',
    );
    const throws = collectDirectThrows(method);
    expect(throws).toHaveLength(1);
    expect(throws[0]?.expression.getText()).toContain("'b'");
  });

  it('collects a throw inside a finally block', () => {
    const method = findMethod(
      `class C { m() { try { doThing(); } finally { throw new Error('x'); } } }`,
      'm',
    );
    expect(collectDirectThrows(method)).toHaveLength(1);
  });

  it('collects a throw in a try with no catch (only finally) — nothing swallows it', () => {
    const method = findMethod(
      `class C { m() { try { throw new Error('x'); } finally { cleanup(); } } }`,
      'm',
    );
    expect(collectDirectThrows(method)).toHaveLength(1);
  });

  it('a throw swallowed by an outer catch stays swallowed even inside a nested try/catch', () => {
    const method = findMethod(
      `class C { m() {
        try {
          try { throw new Error('inner'); } catch { throw new Error('rethrown'); }
        } catch { return null; }
      } }`,
      'm',
    );
    expect(collectDirectThrows(method)).toHaveLength(0);
  });

  it('does NOT collect a throw statement after an unconditional return in the same block', () => {
    const method = findMethod(`class C { m() { return 1; throw new Error('x'); } }`, 'm');
    expect(collectDirectThrows(method)).toHaveLength(0);
  });

  it('does NOT collect a throw statement after an unconditional throw in the same block', () => {
    const method = findMethod(
      `class C { m() { throw new Error('a'); throw new Error('b'); } }`,
      'm',
    );
    expect(collectDirectThrows(method)).toHaveLength(1);
  });

  it('does NOT collect a throw inside an `if (false)` body', () => {
    const method = findMethod(`class C { m() { if (false) { throw new Error('x'); } } }`, 'm');
    expect(collectDirectThrows(method)).toHaveLength(0);
  });

  it('does NOT collect a throw inside a `while (0)` body', () => {
    const method = findMethod(`class C { m() { while (0) { throw new Error('x'); } } }`, 'm');
    expect(collectDirectThrows(method)).toHaveLength(0);
  });

  it('still collects the else branch of an `if (false)`', () => {
    const method = findMethod(
      `class C { m(x: boolean) { if (false) { return 1; } else { throw new Error('x'); } } }`,
      'm',
    );
    expect(collectDirectThrows(method)).toHaveLength(1);
  });

  it('returns [] for a bodyless method (overload signature)', () => {
    const program = createInMemoryProgram(
      { 'main.ts': `class C { m(): void; m(x?: number): void {} }` },
      ['main.ts'],
      {
        target: ts.ScriptTarget.ES2022,
        experimentalDecorators: true,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
      },
    );
    const sourceFile = program.getSourceFile('main.ts');
    if (!sourceFile) throw new Error('missing main.ts');
    let overload: ts.MethodDeclaration | undefined;
    ts.forEachChild(sourceFile, function visit(node) {
      if (ts.isMethodDeclaration(node) && node.body === undefined) overload = node;
      ts.forEachChild(node, visit);
    });
    if (!overload) throw new Error('overload signature not found');
    expect(collectDirectThrows(overload)).toEqual([]);
  });
});
