import { describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import { getBaseClassDeclaration, resolveClassDeclaration } from '../../src/core/heritage.js';
import { createInMemoryProgram } from '../helpers/in-memory-program.js';

const STUB = `
  declare module '@nestjs/common' {
    export class HttpException extends Error {
      constructor(response: string, status: number);
    }
    export class NotFoundException extends HttpException {
      constructor(message?: string);
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

function findClass(sourceFile: ts.SourceFile, name: string): ts.ClassDeclaration {
  let found: ts.ClassDeclaration | undefined;
  ts.forEachChild(sourceFile, function visit(node) {
    if (ts.isClassDeclaration(node) && node.name?.text === name) found = node;
    ts.forEachChild(node, visit);
  });
  if (!found) throw new Error(`class ${name} not found`);
  return found;
}

function buildProgram(mainSource: string): { program: ts.Program; sourceFile: ts.SourceFile } {
  const program = createInMemoryProgram(
    { 'stub.d.ts': STUB, 'main.ts': mainSource },
    ['stub.d.ts', 'main.ts'],
    COMPILER_OPTIONS,
  );
  const sourceFile = program.getSourceFile('main.ts');
  if (!sourceFile) throw new Error('missing main.ts');
  return { program, sourceFile };
}

describe('#11: mixin-based classes (extends SomeMixin(Base))', () => {
  it('getBaseClassDeclaration resolves through a non-generic mixin call to the class it returns', () => {
    const { program, sourceFile } = buildProgram(
      `import { NotFoundException } from '@nestjs/common';

       function SomeMixin(Base: typeof NotFoundException) {
         class Mixed extends Base {
           extra(): void {}
         }
         return Mixed;
       }

       class MyNotFound extends SomeMixin(NotFoundException) {}`,
    );
    const checker = program.getTypeChecker();
    const myNotFound = findClass(sourceFile, 'MyNotFound');

    const base = getBaseClassDeclaration(myNotFound, checker);
    expect(base?.name?.getText()).toBe('Mixed');
  });

  it('the resolved mixin base itself continues to resolve up a non-generic chain to the @nestjs/common ancestor', () => {
    const { program, sourceFile } = buildProgram(
      `import { NotFoundException } from '@nestjs/common';

       function SomeMixin(Base: typeof NotFoundException) {
         class Mixed extends Base {
           extra(): void {}
         }
         return Mixed;
       }

       class MyNotFound extends SomeMixin(NotFoundException) {}`,
    );
    const checker = program.getTypeChecker();
    const myNotFound = findClass(sourceFile, 'MyNotFound');

    const mixed = getBaseClassDeclaration(myNotFound, checker);
    expect(mixed).toBeDefined();
    const base = mixed && getBaseClassDeclaration(mixed, checker);
    expect(base?.name?.getText()).toBe('NotFoundException');
  });

  it("resolveClassDeclaration resolves a plain identifier holding a mixin call result (Passport `AuthGuard('jwt')` pattern)", () => {
    const { program, sourceFile } = buildProgram(
      `class AuthGuardBase {
         canActivate(): boolean { return true; }
       }

       function AuthGuard(strategy: string) {
         class MixinAuthGuard extends AuthGuardBase {
           canActivate(): boolean { return strategy !== ''; }
         }
         return MixinAuthGuard;
       }

       const AuthGuardJwt = AuthGuard('jwt');`,
    );
    const checker = program.getTypeChecker();

    let identifier: ts.Identifier | undefined;
    ts.forEachChild(sourceFile, function visit(node) {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === 'AuthGuardJwt' &&
        node.initializer &&
        ts.isIdentifier(node.name)
      ) {
        // Use a reference expression, not the declaration's own name, to
        // mirror how `guards.ts` calls this — on a `@UseGuards(AuthGuardJwt)`
        // decorator argument, a USE site, not the declaration.
        identifier = node.name;
      }
      ts.forEachChild(node, visit);
    });
    if (!identifier) throw new Error('AuthGuardJwt declaration not found');

    const resolved = resolveClassDeclaration(identifier, checker);
    expect(resolved?.name?.getText()).toBe('MixinAuthGuard');
  });

  it('resolveClassDeclaration resolves an inline mixin call directly (no intermediate variable)', () => {
    const { program, sourceFile } = buildProgram(
      `class AuthGuardBase {
         canActivate(): boolean { return true; }
       }

       function AuthGuard(strategy: string) {
         class MixinAuthGuard extends AuthGuardBase {
           canActivate(): boolean { return strategy !== ''; }
         }
         return MixinAuthGuard;
       }

       const useGuardsArg = AuthGuard('jwt');`,
    );
    const checker = program.getTypeChecker();

    let callExpr: ts.CallExpression | undefined;
    ts.forEachChild(sourceFile, function visit(node) {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'AuthGuard'
      ) {
        callExpr = node;
      }
      ts.forEachChild(node, visit);
    });
    if (!callExpr) throw new Error('AuthGuard(...) call not found');

    const resolved = resolveClassDeclaration(callExpr, checker);
    expect(resolved?.name?.getText()).toBe('MixinAuthGuard');
  });

  it('a genuinely unresolvable factory (returns a plain object literal, not a class) still resolves to undefined', () => {
    const { program, sourceFile } = buildProgram(
      `function notAMixin() {
         return { canActivate: () => true };
       }
       const notAGuard = notAMixin();`,
    );
    const checker = program.getTypeChecker();

    let identifier: ts.Identifier | undefined;
    ts.forEachChild(sourceFile, function visit(node) {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === 'notAGuard'
      ) {
        identifier = node.name;
      }
      ts.forEachChild(node, visit);
    });
    if (!identifier) throw new Error('notAGuard declaration not found');

    expect(resolveClassDeclaration(identifier, checker)).toBeUndefined();
  });

  it('(adversarial P2) resolves through a genuinely GENERIC mixin — `Timestamped<TBase extends Ctor>(Base: TBase)` — not just the non-generic strawman', () => {
    const { program, sourceFile } = buildProgram(
      `import { NotFoundException } from '@nestjs/common';

       type Ctor<T = {}> = new (...args: any[]) => T;
       function Timestamped<TBase extends Ctor>(Base: TBase) {
         return class extends Base {
           ts = 0;
         };
       }

       class MyErr extends Timestamped(NotFoundException) {}`,
    );
    const checker = program.getTypeChecker();
    const myErr = findClass(sourceFile, 'MyErr');

    const base = getBaseClassDeclaration(myErr, checker);
    // The checker types the call's return as an intersection of the
    // anonymous mixin class and `NotFoundException` itself (the generic
    // parameter substituted in) — resolving to the named `NotFoundException`
    // constituent (rather than the anonymous wrapper) is what lets the
    // extends-chain walk in `resolve-status.ts` find it.
    expect(base?.name?.getText()).toBe('NotFoundException');
  });

  it('(adversarial P3) does not resolve a union-returning factory to an arbitrary arm', () => {
    const { program, sourceFile } = buildProgram(
      `class ProdGuard { canActivate(): boolean { return false; } }
       class NoopGuard { canActivate(): boolean { return true; } }
       declare function pickGuard(env: string): typeof ProdGuard | typeof NoopGuard;
       const G = pickGuard('x');`,
    );
    const checker = program.getTypeChecker();

    let identifier: ts.Identifier | undefined;
    ts.forEachChild(sourceFile, function visit(node) {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'G') {
        identifier = node.name;
      }
      ts.forEachChild(node, visit);
    });
    if (!identifier) throw new Error('G declaration not found');

    // Must stay unresolved — silently picking `ProdGuard` (or `NoopGuard`,
    // depending on which arm the checker lists first) would be a
    // source-order-dependent false positive/negative, not a real answer.
    expect(resolveClassDeclaration(identifier, checker)).toBeUndefined();
  });

  it('(adversarial P5) a self-referential `extends` through the type fallback resolves to undefined, not the class itself', () => {
    const { program, sourceFile } = buildProgram(
      `declare const Self: typeof MyClass;
       class MyClass extends Self {}`,
    );
    const checker = program.getTypeChecker();
    const myClass = findClass(sourceFile, 'MyClass');

    expect(getBaseClassDeclaration(myClass, checker)).toBeUndefined();
  });
});
