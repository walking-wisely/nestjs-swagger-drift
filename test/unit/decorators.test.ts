import { describe, expect, it, beforeAll } from 'vitest';
import * as ts from 'typescript';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createProgramFromTsConfig } from '../../src/cli/program.js';
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
