import { describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import { createInMemoryProgram } from '../helpers/in-memory-program.js';
import { getHandlersForClass, getHandlerInfosForMethod } from '../../src/core/handlers.js';

function findClassExpression(program: ts.Program, fileName: string): ts.ClassExpression {
  const sourceFile = program.getSourceFile(fileName);
  if (!sourceFile) throw new Error(`missing ${fileName}`);
  let result: ts.ClassExpression | undefined;
  ts.forEachChild(sourceFile, function visit(node) {
    if (ts.isClassExpression(node)) result = node;
    ts.forEachChild(node, visit);
  });
  if (!result) throw new Error('no class expression found');
  return result;
}

describe('getHandlersForClass over a decorated class expression (S6)', () => {
  // Decorators on class *expressions* are only syntactically valid under
  // TC39 standard decorators, not `experimentalDecorators` (verified: TS1249
  // "Decorators are not valid here" under the legacy mode) — so this needs
  // its own in-memory program rather than reusing the shared fixtures, which
  // use `experimentalDecorators` to match real-world NestJS.
  const STUB = `
    declare module '@nestjs/common' {
      export function Controller(prefix?: string): ClassDecorator;
      export function Get(path?: string): MethodDecorator;
    }
  `;
  const MAIN = `
    import { Controller, Get } from '@nestjs/common';
    function identity<T>(x: T): T { return x; }
    export const ExprController = identity(
      @Controller('expr')
      class {
        @Get('expr')
        ping(): string { return 'expr'; }
      },
    );
  `;

  const program = createInMemoryProgram(
    { 'stub.d.ts': STUB, 'main.ts': MAIN },
    ['stub.d.ts', 'main.ts'],
    {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
    },
  );
  const checker = program.getTypeChecker();

  it('finds routes on a class expression, not just class declarations', () => {
    const classExpr = findClassExpression(program, 'main.ts');
    const handlers = getHandlersForClass(classExpr, { checker });
    expect(handlers).toHaveLength(1);
    expect(handlers[0]?.httpMethod).toBe('GET');
    expect(handlers[0]?.path).toBe('/expr/expr');
    expect(handlers[0]?.className).toBe('<anonymous>');
  });

  it('getHandlerInfosForMethod matches getHandlersForClass for the same method (PLAN §2.1 shape)', () => {
    const classExpr = findClassExpression(program, 'main.ts');
    const method = classExpr.members.find(ts.isMethodDeclaration);
    if (!method) throw new Error('no method found');
    const viaMethod = getHandlerInfosForMethod(method, { checker });
    const viaClass = getHandlersForClass(classExpr, { checker });
    expect(viaMethod).toEqual(viaClass);
  });
});

// Issue #8: a handler carrying only `@Sse()` (no `@Get()`) must still be
// discovered as a GET route by `getHandlersForClass` — before this was
// wired into `HTTP_METHOD_DECORATOR_NAMES`, it produced zero `HandlerInfo`s
// at all, i.e. the route was entirely invisible.
describe('getHandlersForClass discovers @Sse() as a GET route (issue #8)', () => {
  const STUB = `
    declare module '@nestjs/common' {
      export function Controller(prefix?: string): ClassDecorator;
      export function Get(path?: string): MethodDecorator;
      export function Sse(path?: string): MethodDecorator;
    }
  `;
  const MAIN = `
    import { Controller, Get, Sse } from '@nestjs/common';

    @Controller('events')
    export class EventsController {
      @Sse('stream')
      stream(): unknown { return undefined; }

      @Get('list')
      list(): unknown[] { return []; }
    }
  `;

  const program = createInMemoryProgram(
    { 'stub.d.ts': STUB, 'main.ts': MAIN },
    ['stub.d.ts', 'main.ts'],
    {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      experimentalDecorators: true,
    },
  );
  const checker = program.getTypeChecker();

  it('includes the @Sse() handler, mapped to GET, alongside the @Get() one', () => {
    const sourceFile = program.getSourceFile('main.ts');
    if (!sourceFile) throw new Error('missing main.ts');
    let classDecl: ts.ClassDeclaration | undefined;
    ts.forEachChild(sourceFile, (node) => {
      if (ts.isClassDeclaration(node)) classDecl = node;
    });
    if (!classDecl) throw new Error('no class found');

    const handlers = getHandlersForClass(classDecl, { checker });
    const byMethod = new Map(handlers.map((h) => [h.methodName, h]));
    expect(byMethod.get('stream')).toMatchObject({ httpMethod: 'GET', path: '/events/stream' });
    expect(byMethod.get('list')).toMatchObject({ httpMethod: 'GET', path: '/events/list' });
  });
});
