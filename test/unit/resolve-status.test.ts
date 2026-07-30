import { describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import { resolveThrownStatus } from '../../src/core/resolve-status.js';
import { createInMemoryProgram } from '../helpers/in-memory-program.js';

const STUB = `
  declare module '@nestjs/common' {
    export class HttpException extends Error {
      constructor(response: string, status: number);
    }
    export class NotFoundException extends HttpException {
      constructor(message?: string);
    }
    export class ConflictException extends HttpException {
      constructor(message?: string);
    }
    export enum HttpStatus {
      NOT_FOUND = 404,
      CONFLICT = 409,
    }
  }
`;

const COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  experimentalDecorators: true,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
};

function resolveFirstThrow(mainSource: string): ReturnType<typeof resolveThrownStatus> {
  const program = createInMemoryProgram(
    { 'stub.d.ts': STUB, 'main.ts': mainSource },
    ['stub.d.ts', 'main.ts'],
    COMPILER_OPTIONS,
  );
  const checker = program.getTypeChecker();
  const sourceFile = program.getSourceFile('main.ts');
  if (!sourceFile) throw new Error('missing main.ts');

  let thrown: ts.Expression | undefined;
  ts.forEachChild(sourceFile, function visit(node) {
    if (ts.isThrowStatement(node) && node.expression && thrown === undefined) {
      thrown = node.expression;
    }
    ts.forEachChild(node, visit);
  });
  if (!thrown) throw new Error('no throw statement found');
  return resolveThrownStatus(thrown, checker);
}

describe('resolveThrownStatus', () => {
  it('resolves a built-in exception class to its table status', () => {
    const result = resolveFirstThrow(
      `import { NotFoundException } from '@nestjs/common';
       function f() { throw new NotFoundException('x'); }`,
    );
    expect(result).toEqual({
      kind: 'resolved',
      status: 404,
      confidence: 'high',
      exception: 'NotFoundException',
    });
  });

  it('resolves new HttpException(msg, <numeric literal>)', () => {
    const result = resolveFirstThrow(
      `import { HttpException } from '@nestjs/common';
       function f() { throw new HttpException('x', 409); }`,
    );
    expect(result).toEqual({
      kind: 'resolved',
      status: 409,
      confidence: 'high',
      exception: 'HttpException',
    });
  });

  it('resolves new HttpException(msg, HttpStatus.X)', () => {
    const result = resolveFirstThrow(
      `import { HttpException, HttpStatus } from '@nestjs/common';
       function f() { throw new HttpException('x', HttpStatus.CONFLICT); }`,
    );
    expect(result).toEqual({
      kind: 'resolved',
      status: 409,
      confidence: 'high',
      exception: 'HttpException',
    });
  });

  it('resolves a rethrow via a class-typed identifier, using the CLASS name (not the variable name)', () => {
    const result = resolveFirstThrow(
      `import { NotFoundException } from '@nestjs/common';
       function f() {
         const err = new NotFoundException('x');
         throw err;
       }`,
    );
    expect(result).toEqual({
      kind: 'resolved',
      status: 404,
      confidence: 'high',
      exception: 'NotFoundException',
    });
  });

  it('a user class named NotFoundException (shadowing the real one) resolves to unknown, not 404', () => {
    const result = resolveFirstThrow(
      `class NotFoundException extends Error {}
       function f() { throw new NotFoundException(); }`,
    );
    expect(result.kind).toBe('unknown');
  });

  it('a custom exception extending a built-in resolves to unknown (extends chains are Phase 3)', () => {
    const result = resolveFirstThrow(
      `import { NotFoundException } from '@nestjs/common';
       class MyNotFound extends NotFoundException {}
       function f() { throw new MyNotFound('x'); }`,
    );
    expect(result.kind).toBe('unknown');
  });

  it('HttpException with a dynamic (non-literal) status resolves to unknown', () => {
    const result = resolveFirstThrow(
      `import { HttpException } from '@nestjs/common';
       function f(status: number) { throw new HttpException('x', status); }`,
    );
    expect(result.kind).toBe('unknown');
  });

  it('HttpException with no status argument resolves to unknown', () => {
    // Missing the required second argument is a type error in the fixture's
    // own stub, but `resolveThrownStatus` operates on syntax/type info that
    // is still available even when the program has diagnostics — and this
    // is exactly the shape (an `HttpException` call with an unresolvable
    // status) the strategy ladder must not guess at.
    const result = resolveFirstThrow(
      `import { HttpException } from '@nestjs/common';
       function f() { throw new HttpException('x'); }`,
    );
    expect(result.kind).toBe('unknown');
  });

  it('a thrown non-Error literal resolves to unknown', () => {
    const result = resolveFirstThrow(`function f() { throw 'oops'; }`);
    expect(result.kind).toBe('unknown');
  });

  it('a rethrow of an untyped (unknown/any) caught identifier resolves to unknown', () => {
    const result = resolveFirstThrow(
      `function f() {
         try { doSomething(); } catch (err) { throw err; }
       }
       declare function doSomething(): void;`,
    );
    expect(result.kind).toBe('unknown');
  });
});
