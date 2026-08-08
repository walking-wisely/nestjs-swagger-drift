import { describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import { getDocumentedStatuses } from '../../src/core/documented.js';
import type { AnalysisOptions } from '../../src/core/types.js';
import { createInMemoryProgram } from '../helpers/in-memory-program.js';

const STUB = `
  declare module '@nestjs/swagger' {
    export interface ApiResponseOptions { status?: number | string; description?: string; }
    export function ApiResponse(options?: ApiResponseOptions): MethodDecorator & ClassDecorator;
    export function ApiNotFoundResponse(options?: ApiResponseOptions): MethodDecorator & ClassDecorator;
    export function ApiConflictResponse(options?: ApiResponseOptions): MethodDecorator & ClassDecorator;
    export function ApiForbiddenResponse(options?: ApiResponseOptions): MethodDecorator & ClassDecorator;
    export function ApiDefaultResponse(options?: ApiResponseOptions): MethodDecorator & ClassDecorator;
  }
  declare module '@nestjs/common' {
    export enum HttpStatus { NOT_FOUND = 404, CONFLICT = 409 }
  }
`;

const COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  experimentalDecorators: true,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
};

function defaultOptions(): AnalysisOptions {
  return {
    maxDepth: 2,
    rules: { 'documented-but-unreachable': false, 'unresolvable-status': false },
    treatDefaultAsWildcard: false,
    ignoreStatuses: [],
  };
}

function analyzeMethod(mainSource: string, methodName: string, options = defaultOptions()) {
  const program = createInMemoryProgram(
    { 'stub.d.ts': STUB, 'main.ts': mainSource },
    ['stub.d.ts', 'main.ts'],
    COMPILER_OPTIONS,
  );
  const checker = program.getTypeChecker();
  const sourceFile = program.getSourceFile('main.ts');
  if (!sourceFile) throw new Error('missing main.ts');

  let method: ts.MethodDeclaration | undefined;
  ts.forEachChild(sourceFile, function visit(node) {
    if (
      ts.isMethodDeclaration(node) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      node.name.text === methodName
    ) {
      method = node;
    }
    ts.forEachChild(node, visit);
  });
  if (!method) throw new Error(`method ${methodName} not found`);
  return getDocumentedStatuses(method, checker, options);
}

describe('getDocumentedStatuses', () => {
  it('reads @ApiResponse({ status: N }) as a numeric literal', () => {
    const result = analyzeMethod(`class C { @ApiResponse({ status: 404 }) m() {} }`, 'm');
    expect(result).toEqual([
      expect.objectContaining({ status: 404, decorator: 'ApiResponse', level: 'method' }),
    ]);
  });

  it('reads @ApiResponse({ status: HttpStatus.X })', () => {
    const result = analyzeMethod(
      `import { HttpStatus } from '@nestjs/common';
       class C { @ApiResponse({ status: HttpStatus.CONFLICT }) m() {} }`,
      'm',
    );
    expect(result).toEqual([
      expect.objectContaining({ status: 409, decorator: 'ApiResponse', level: 'method' }),
    ]);
  });

  it('reads a shorthand decorator', () => {
    const result = analyzeMethod(`class C { @ApiNotFoundResponse() m() {} }`, 'm');
    expect(result).toEqual([
      expect.objectContaining({ status: 404, decorator: 'ApiNotFoundResponse', level: 'method' }),
    ]);
  });

  it('merges class-level and method-level decorators', () => {
    const result = analyzeMethod(
      `@ApiConflictResponse()
       class C { @ApiNotFoundResponse() m() {} }`,
      'm',
    );
    const statuses = result.map((r) => r.status).sort();
    expect(statuses).toEqual([404, 409]);
    expect(result.find((r) => r.status === 409)?.level).toBe('class');
    expect(result.find((r) => r.status === 404)?.level).toBe('method');
  });

  it('ignores @ApiResponse with no status property', () => {
    const result = analyzeMethod(`class C { @ApiResponse({ description: 'x' }) m() {} }`, 'm');
    expect(result).toEqual([]);
  });

  it('@ApiDefaultResponse contributes nothing when treatDefaultAsWildcard is false (the default)', () => {
    const result = analyzeMethod(`class C { @ApiDefaultResponse() m() {} }`, 'm');
    expect(result).toEqual([]);
  });

  it('@ApiDefaultResponse contributes a wildcard status when treatDefaultAsWildcard is true', () => {
    const result = analyzeMethod(`class C { @ApiDefaultResponse() m() {} }`, 'm', {
      ...defaultOptions(),
      treatDefaultAsWildcard: true,
    });
    expect(result).toEqual([
      expect.objectContaining({ status: 'default', decorator: 'ApiDefaultResponse' }),
    ]);
  });

  it('a locally-declared decorator only sharing the name ApiNotFoundResponse is rejected', () => {
    const result = analyzeMethod(
      `function ApiNotFoundResponse() { return () => undefined; }
       class C { @ApiNotFoundResponse() m() {} }`,
      'm',
    );
    expect(result).toEqual([]);
  });

  // --- Object.prototype pollution guard (adversarial review of PR #21) ---

  it('a shorthand-table lookup on an Object.prototype-colliding name does not crash and is not treated as documented', () => {
    // `toString` need not even be a real `@nestjs/swagger` export — the
    // decorator recognizer falls back to name-based matching when the
    // checker can't resolve the import (see decorators.ts's `Provenance`
    // doc comment), so this alone is enough to make `effectiveName ===
    // 'toString'` reach the shorthand lookup.
    expect(() =>
      analyzeMethod(
        `import { toString } from '@nestjs/swagger';
         class C { @toString() m() {} }`,
        'm',
      ),
    ).not.toThrow();
    const result = analyzeMethod(
      `import { toString } from '@nestjs/swagger';
       class C { @toString() m() {} }`,
      'm',
    );
    expect(result).toEqual([]);
  });

  it('other Object.prototype-colliding shorthand names (valueOf, constructor, hasOwnProperty) are likewise ignored', () => {
    for (const name of ['valueOf', 'constructor', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString']) {
      const result = analyzeMethod(
        `import { ${name} } from '@nestjs/swagger';
         class C { @${name}() m() {} }`,
        'm',
      );
      expect(result).toEqual([]);
    }
  });

  it('a legitimate own-property shorthand lookup still works alongside the guard', () => {
    const result = analyzeMethod(`class C { @ApiNotFoundResponse() m() {} }`, 'm');
    expect(result).toEqual([
      expect.objectContaining({ status: 404, decorator: 'ApiNotFoundResponse', level: 'method' }),
    ]);
  });

  // --- Phase 2 review S1: class-level decorators on an ancestor class ---

  it("reads a class-level decorator from a BASE class, not just the handler's own class", () => {
    const result = analyzeMethod(
      `@ApiForbiddenResponse()
       class Base {}
       class C extends Base { @ApiNotFoundResponse() m() {} }`,
      'm',
    );
    const statuses = result.map((r) => r.status).sort();
    expect(statuses).toEqual([403, 404]);
    expect(result.find((r) => r.status === 403)?.level).toBe('class');
  });

  it('walks multiple levels of inheritance', () => {
    const result = analyzeMethod(
      `@ApiForbiddenResponse()
       class Grandparent {}
       class Parent extends Grandparent {}
       class C extends Parent { m() {} }`,
      'm',
    );
    expect(result).toEqual([expect.objectContaining({ status: 403, level: 'class' })]);
  });

  // --- Phase 2 review S2: argument shapes ---

  it('reads { status } as a shorthand property assignment', () => {
    const result = analyzeMethod(
      // `export {}` makes this file a module rather than a global script —
      // without it, top-level `const status` collides with lib.dom.d.ts's
      // ambient `declare var status: string`, and the checker resolves the
      // shorthand reference to the wrong (global) symbol.
      `export {};
       const status = 404;
       class C { @ApiResponse({ status }) m() {} }`,
      'm',
    );
    expect(result).toEqual([expect.objectContaining({ status: 404 })]);
  });

  it('reads a module-level const object passed directly as the decorator argument', () => {
    const result = analyzeMethod(
      `const OPTS = { status: 404, description: 'x' };
       class C { @ApiResponse(OPTS) m() {} }`,
      'm',
    );
    expect(result).toEqual([expect.objectContaining({ status: 404 })]);
  });

  it('reads { ...base, status: 404 } (spread present, but status is a direct literal)', () => {
    const result = analyzeMethod(
      `const base = { description: 'x' };
       class C { @ApiResponse({ ...base, status: 404 }) m() {} }`,
      'm',
    );
    expect(result).toEqual([expect.objectContaining({ status: 404 })]);
  });

  it('treats an unresolvable spread-only status as an FP-safe wildcard, not "documents nothing"', () => {
    const result = analyzeMethod(
      `declare const dynamicOpts: { status: number };
       class C { @ApiResponse({ ...dynamicOpts }) m() {} }`,
      'm',
    );
    expect(result).toEqual([
      expect.objectContaining({ status: 'default', decorator: 'ApiResponse' }),
    ]);
  });

  it('reads a "4XX" range wildcard', () => {
    const result = analyzeMethod(`class C { @ApiResponse({ status: '4XX' }) m() {} }`, 'm');
    expect(result).toEqual([expect.objectContaining({ status: '4XX' })]);
  });
});
