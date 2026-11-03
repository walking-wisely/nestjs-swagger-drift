import { describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import { findingConfidence } from '../../src/core/explain.js';
import type { Finding, StatusSource } from '../../src/core/types.js';
import { createInMemoryProgram } from '../helpers/in-memory-program.js';

function throwNode(code: string): ts.ThrowStatement {
  const program = createInMemoryProgram({ 'main.ts': code }, ['main.ts'], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  });
  let found: ts.ThrowStatement | undefined;
  ts.forEachChild(program.getSourceFile('main.ts')!, function visit(node) {
    if (ts.isThrowStatement(node)) found = node;
    ts.forEachChild(node, visit);
  });
  return found!;
}

function serviceSource(code: string): StatusSource {
  return { kind: 'service-throw', node: throwNode(code), exception: 'NotFoundException', via: [] };
}

function finding(sources: StatusSource[]): Finding {
  return { rule: 'undocumented-status', status: 404, sources } as unknown as Finding;
}

describe('findingConfidence', () => {
  it('is low for a throw inside a catch block', () => {
    const source = serviceSource(
      `function f() { try { g(); } catch (e) { throw new Error('x'); } } declare function g(): void;`,
    );
    expect(findingConfidence(finding([source]))).toEqual({
      level: 'low',
      reasons: ['throw inside a catch block'],
    });
  });

  it('is low when the only guard is a bare parameter emptiness check', () => {
    const source = serviceSource(`function f(id: string) { if (!id) { throw new Error('x'); } }`);
    expect(findingConfidence(finding([source])).level).toBe('low');
  });

  it('is high when the guard reads something richer than the parameter itself', () => {
    const source = serviceSource(
      `function f(id: string) { if (id.length > 3) { throw new Error('x'); } }`,
    );
    expect(findingConfidence(finding([source])).level).toBe('high');
  });

  it('is high for an unconditional throw', () => {
    expect(
      findingConfidence(finding([serviceSource(`function f() { throw new Error('x'); }`)])).level,
    ).toBe('high');
  });

  it('is high when any one source is strong', () => {
    const weak = serviceSource(`function f(id: string) { if (!id) { throw new Error('x'); } }`);
    const strong = serviceSource(`function f() { throw new Error('x'); }`);
    expect(findingConfidence(finding([weak, strong])).level).toBe('high');
  });

  it('is high for an implicit success status', () => {
    const node = ts.factory.createIdentifier('x');
    expect(findingConfidence(finding([{ kind: 'implicit', node, reason: 'success' }])).level).toBe(
      'high',
    );
  });
});
