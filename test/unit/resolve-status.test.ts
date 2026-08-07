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

  it('a custom exception directly extending a built-in inherits its status', () => {
    const result = resolveFirstThrow(
      `import { NotFoundException } from '@nestjs/common';
       class MyNotFound extends NotFoundException {}
       function f() { throw new MyNotFound('x'); }`,
    );
    expect(result).toEqual({
      kind: 'resolved',
      status: 404,
      confidence: 'high',
      exception: 'MyNotFound',
    });
  });

  it('#11: a mixin-based custom exception (extends SomeMixin(Base)) inherits the mixed-in status', () => {
    const result = resolveFirstThrow(
      `import { NotFoundException } from '@nestjs/common';
       function SomeMixin(Base: typeof NotFoundException) {
         class Mixed extends Base {
           extra(): void {}
         }
         return Mixed;
       }
       class MyMixedNotFound extends SomeMixin(NotFoundException) {}
       function f() { throw new MyMixedNotFound('x'); }`,
    );
    expect(result).toEqual({
      kind: 'resolved',
      status: 404,
      confidence: 'high',
      exception: 'MyMixedNotFound',
    });
  });

  it('walks the whole extends chain (A extends B extends NotFoundException)', () => {
    const result = resolveFirstThrow(
      `import { NotFoundException } from '@nestjs/common';
       class B extends NotFoundException {}
       class A extends B {}
       function f() { throw new A('x'); }`,
    );
    expect(result).toEqual({
      kind: 'resolved',
      status: 404,
      confidence: 'high',
      exception: 'A',
    });
  });

  it('extends HttpException with an explicit numeric literal super() status', () => {
    const result = resolveFirstThrow(
      `import { HttpException } from '@nestjs/common';
       class RateLimited extends HttpException {
         constructor() { super('slow down', 429); }
       }
       function f() { throw new RateLimited(); }`,
    );
    expect(result).toEqual({
      kind: 'resolved',
      status: 429,
      confidence: 'high',
      exception: 'RateLimited',
    });
  });

  it('extends HttpException with super(msg, HttpStatus.X)', () => {
    const result = resolveFirstThrow(
      `import { HttpException, HttpStatus } from '@nestjs/common';
       class MyConflict extends HttpException {
         constructor() { super('conflict', HttpStatus.CONFLICT); }
       }
       function f() { throw new MyConflict(); }`,
    );
    expect(result).toEqual({
      kind: 'resolved',
      status: 409,
      confidence: 'high',
      exception: 'MyConflict',
    });
  });

  it('extends HttpException with a constructor status parameter default is low confidence', () => {
    const result = resolveFirstThrow(
      `import { HttpException } from '@nestjs/common';
       class MaybeConflict extends HttpException {
         constructor(status = 409) { super('conflict', status); }
       }
       function f() { throw new MaybeConflict(); }`,
    );
    expect(result).toEqual({
      kind: 'resolved',
      status: 409,
      confidence: 'low',
      exception: 'MaybeConflict',
    });
  });

  it('an explicit nearer super(msg, <literal>) wins over an inherited default further up', () => {
    const result = resolveFirstThrow(
      `import { HttpException } from '@nestjs/common';
       class BaseError extends HttpException {
         constructor(msg: string, status = 500) { super(msg, status); }
       }
       class ConflictError extends BaseError {
         constructor() { super('conflict', 409); }
       }
       function f() { throw new ConflictError(); }`,
    );
    expect(result).toEqual({
      kind: 'resolved',
      status: 409,
      confidence: 'high',
      exception: 'ConflictError',
    });
  });

  it('extends HttpException with a dynamically computed status resolves to unknown', () => {
    const result = resolveFirstThrow(
      `import { HttpException } from '@nestjs/common';
       class Weird extends HttpException {
         constructor(cond: boolean) { super('x', cond ? 400 : 409); }
       }
       function f(cond: boolean) { throw new Weird(cond); }`,
    );
    expect(result.kind).toBe('unknown');
  });

  it('extends HttpException with super(...args) spread forwarding resolves to unknown', () => {
    const result = resolveFirstThrow(
      `import { HttpException } from '@nestjs/common';
       class Forwarding extends HttpException {
         constructor(...args: [string, number]) { super(...args); }
       }
       function f() { throw new Forwarding('x', 409); }`,
    );
    expect(result.kind).toBe('unknown');
  });

  it('extends HttpException with no resolvable status anywhere in the chain resolves to unknown', () => {
    const result = resolveFirstThrow(
      `import { HttpException } from '@nestjs/common';
       class NoStatus extends HttpException {}
       function f() { throw new NoStatus(); }`,
    );
    expect(result.kind).toBe('unknown');
  });

  it('a class extending something that only looks like a Nest exception (not checker-verified) resolves to unknown', () => {
    const result = resolveFirstThrow(
      `class NotFoundException { constructor(public msg?: string) {} }
       class MyNotFound extends NotFoundException {}
       function f() { throw new MyNotFound('x'); }`,
    );
    expect(result.kind).toBe('unknown');
  });

  it('a custom exception with no extends clause at all resolves to unknown', () => {
    const result = resolveFirstThrow(
      `class PlainError extends Error {}
       function f() { throw new PlainError('x'); }`,
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

  describe('#14: a typed rethrow wrapped in a non-null assertion or cast', () => {
    it('resolves `throw err!` when the identifier is itself narrowed to a known exception class', () => {
      const result = resolveFirstThrow(
        `import { NotFoundException } from '@nestjs/common';
         function f() {
           let err: NotFoundException | undefined;
           err = new NotFoundException('x');
           throw err!;
         }`,
      );
      expect(result).toEqual({
        kind: 'resolved',
        status: 404,
        confidence: 'high',
        exception: 'NotFoundException',
      });
    });

    it('resolves `throw err!` after an `instanceof` narrows the caught identifier', () => {
      const result = resolveFirstThrow(
        `import { NotFoundException } from '@nestjs/common';
         function f() {
           try {
             doSomething();
           } catch (err) {
             if (err instanceof NotFoundException) {
               throw err!;
             }
             throw err;
           }
         }
         declare function doSomething(): void;`,
      );
      expect(result).toEqual({
        kind: 'resolved',
        status: 404,
        confidence: 'high',
        exception: 'NotFoundException',
      });
    });

    it('resolves `throw (err as X)` when parenthesized around a non-null assertion too', () => {
      const result = resolveFirstThrow(
        `import { NotFoundException } from '@nestjs/common';
         function f() {
           let err: NotFoundException | undefined;
           err = new NotFoundException('x');
           throw (err!);
         }`,
      );
      expect(result).toEqual({
        kind: 'resolved',
        status: 404,
        confidence: 'high',
        exception: 'NotFoundException',
      });
    });

    it('does not crash on `throw (err as NotFoundException)` from an untyped catch — stays unknown, not the generic ladder-exhausted message', () => {
      const result = resolveFirstThrow(
        `import { NotFoundException } from '@nestjs/common';
         function f() {
           try {
             doSomething();
           } catch (err) {
             throw (err as NotFoundException);
           }
         }
         declare function doSomething(): void;`,
      );
      // The identifier's own (unnarrowed) type is `unknown`, and the cast is
      // an unverified assertion, not proof — deliberately NOT trusted (this
      // module's "silence over noise" bias), so this still resolves to
      // `unknown`. What changed is that `tryIdentifierRethrow` itself now
      // reaches and reports this, rather than the whole strategy falling
      // through untried to the ladder's generic "no strategy matched"
      // message.
      expect(result.kind).toBe('unknown');
      if (result.kind === 'unknown') {
        expect(result.reason).toContain('not statically typed as a specific exception class');
      }
    });
  });
});
