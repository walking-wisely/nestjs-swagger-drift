import { describe, expect, it, beforeAll } from 'vitest';
import * as ts from 'typescript';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createProgramFromTsConfig } from '../../src/cli/program.js';
import { createInMemoryProgram } from '../helpers/in-memory-program.js';
import { getControllerInfo, getHttpHandlerDecorators } from '../../src/core/decorators.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_TSCONFIG = join(__dirname, '../fixtures/basic/tsconfig.json');

function findClass(
  program: ts.Program,
  fileNameSuffix: string,
  className: string,
): ts.ClassDeclaration {
  for (const sourceFile of program.getSourceFiles()) {
    if (!sourceFile.fileName.endsWith(fileNameSuffix)) continue;
    for (const statement of sourceFile.statements) {
      if (ts.isClassDeclaration(statement) && statement.name?.text === className) {
        return statement;
      }
    }
  }
  throw new Error(`class ${className} not found in ${fileNameSuffix}`);
}

function findMethod(classNode: ts.ClassDeclaration, methodName: string): ts.MethodDeclaration {
  for (const member of classNode.members) {
    if (
      ts.isMethodDeclaration(member) &&
      member.name &&
      ts.isIdentifier(member.name) &&
      member.name.text === methodName
    ) {
      return member;
    }
  }
  throw new Error(`method ${methodName} not found`);
}

describe('decorators', () => {
  let program: ts.Program;
  let checker: ts.TypeChecker;

  beforeAll(() => {
    const outcome = createProgramFromTsConfig(FIXTURE_TSCONFIG);
    if (!outcome.ok) throw new Error('failed to build fixture program');
    program = outcome.result.program;
    checker = program.getTypeChecker();
  });

  it('reads a class-prefixed @Controller and verifies provenance', () => {
    const usersController = findClass(program, 'users.controller.ts', 'UsersController');
    const info = getControllerInfo(usersController, checker);
    expect(info).toBeDefined();
    expect(info?.paths).toEqual(['users']);
  });

  it('reads a bare @Controller() as an empty path', () => {
    const healthController = findClass(program, 'health.controller.ts', 'HealthController');
    const info = getControllerInfo(healthController, checker);
    expect(info?.paths).toEqual(['']);
  });

  it("reads @Get(':id') on a handler method", () => {
    const usersController = findClass(program, 'users.controller.ts', 'UsersController');
    const findOne = findMethod(usersController, 'findOne');
    const decorators = getHttpHandlerDecorators(findOne, checker);
    expect(decorators).toHaveLength(1);
    expect(decorators[0]?.httpMethod).toBe('GET');
    expect(decorators[0]?.paths).toEqual([':id']);
  });

  it('yields one entry per HTTP-method decorator on a multi-decorated method', () => {
    const ordersController = findClass(program, 'orders.controller.ts', 'OrdersController');
    const ping = findMethod(ordersController, 'ping');
    const decorators = getHttpHandlerDecorators(ping, checker);
    const methods = decorators.map((d) => d.httpMethod).sort();
    expect(methods).toEqual(['GET', 'POST']);
    for (const d of decorators) {
      expect(d.paths).toEqual(['ping']);
    }
  });

  it('a non-controller class has no @Controller info', () => {
    const usersService = findClass(program, 'users.controller.ts', 'UsersService');
    expect(getControllerInfo(usersService, checker)).toBeUndefined();
  });

  it('rejects a locally-declared decorator that only shares the name Controller', () => {
    const fakeController = findClass(program, 'fake-controller.ts', 'FakeController');
    expect(getControllerInfo(fakeController, checker)).toBeUndefined();
  });
});

// Issue #8: `@Sse()` was entirely invisible to route discovery —
// `HTTP_METHOD_DECORATOR_NAMES` didn't recognize it at all, so
// `getHttpHandlerDecorators` returned an empty array for a method carrying
// only `@Sse()`, no `@Get()`. NestJS's own routing maps `@Sse` to a GET
// route (`RequestMethod.GET`), so this asserts the same mapping here.
describe('@Sse() route discovery (issue #8)', () => {
  const STUB = `
    declare module '@nestjs/common' {
      export function Controller(prefix?: string): ClassDecorator;
      export function Get(path?: string): MethodDecorator;
      export function Sse(path?: string): MethodDecorator;
    }
  `;
  const MAIN = `
    import { Controller, Sse } from '@nestjs/common';

    @Controller('events')
    export class EventsController {
      @Sse('stream')
      stream(): unknown {
        return undefined;
      }
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

  it('maps a bare @Sse() handler to HttpMethod GET', () => {
    const sourceFile = program.getSourceFile('main.ts');
    if (!sourceFile) throw new Error('missing main.ts');
    let classNode: ts.ClassDeclaration | undefined;
    ts.forEachChild(sourceFile, (node) => {
      if (ts.isClassDeclaration(node)) classNode = node;
    });
    if (!classNode) throw new Error('no class found');
    const method = classNode.members.find(
      (m): m is ts.MethodDeclaration => ts.isMethodDeclaration(m),
    );
    if (!method) throw new Error('no method found');

    const decorators = getHttpHandlerDecorators(method, checker);
    expect(decorators).toHaveLength(1);
    expect(decorators[0]?.httpMethod).toBe('GET');
    expect(decorators[0]?.decoratorName).toBe('Sse');
  });
});
