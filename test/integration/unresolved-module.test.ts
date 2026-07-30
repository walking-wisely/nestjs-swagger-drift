import { describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as ts from 'typescript';
import { createProgramFromTsConfig } from '../../src/cli/program.js';
import { collectDiscoveryWarnings, discoverHandlers } from '../../src/cli/discover.js';
import { EXIT_COULD_NOT_ANALYSE, main } from '../../src/cli/index.js';
import { createInMemoryProgram } from '../helpers/in-memory-program.js';
import { getControllerInfo, getDecoratorInfos } from '../../src/core/decorators.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Regression coverage for the Phase 1 review's B2, round 2: neither
 * `test/fixtures/basic` nor `test/fixtures/edge-cases` can exercise a truly
 * unresolved `@nestjs/common` import, because both ship an ambient
 * `types/nestjs.d.ts` stub that *does* resolve — which is exactly why the
 * bug survived those fixtures. These fixtures deliberately have no stub.
 */
describe('a genuinely unresolved @nestjs/common import (no stub, nothing installed)', () => {
  it('still discovers routes via the name-based fallback, not silence', () => {
    const outcome = createProgramFromTsConfig(
      join(__dirname, '../fixtures/unresolved-module/tsconfig.json'),
    );
    if (!outcome.ok) throw new Error('failed to build program');

    const handlers = discoverHandlers(outcome.result.program);
    expect(handlers).toHaveLength(1);
    expect(handlers[0]).toMatchObject({
      httpMethod: 'GET',
      path: '/users',
      className: 'UsersController',
      methodName: 'findAll',
    });
  });

  it('surfaces an unresolved-module warning naming @nestjs/common', () => {
    const outcome = createProgramFromTsConfig(
      join(__dirname, '../fixtures/unresolved-module/tsconfig.json'),
    );
    if (!outcome.ok) throw new Error('failed to build program');

    const warnings = collectDiscoveryWarnings(outcome.result.program);
    expect(warnings.some((w) => w.kind === 'unresolved-module')).toBe(true);
    // And, per the reconciled-warnings fix: no class here is *also* reported
    // as a rejected mismatch — it was accepted, not rejected, so only one
    // (accurate) warning kind should ever appear for it.
    expect(warnings.some((w) => w.kind === 'rejected-controller-like')).toBe(false);
  });

  it('the built CLI exits 0 (not the could-not-analyse code) when routes were still found', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const code = main([
        '--project',
        join(__dirname, '../fixtures/unresolved-module/tsconfig.json'),
      ]);
      expect(code).toBe(0);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('GET /users'));
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('the built CLI exits EXIT_COULD_NOT_ANALYSE when the module is unresolved AND zero routes were found', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const code = main([
        '--project',
        join(__dirname, '../fixtures/unresolved-module-empty/tsconfig.json'),
      ]);
      expect(code).toBe(EXIT_COULD_NOT_ANALYSE);
      expect(code).not.toBe(0);
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});

describe("a resolved module with a typo'd named export (import { Controllerr })", () => {
  // The module *does* resolve here (an ambient stub is present) — this is
  // the other side of the line from the tests above, requested explicitly
  // in the Phase 1 review follow-up: confirm where a typo'd import lands.
  const STUB = `
    declare module '@nestjs/common' {
      export function Controller(prefix?: string): ClassDecorator;
      export function Get(path?: string): MethodDecorator;
    }
  `;
  const MAIN = `
    import { Controllerr, Get } from '@nestjs/common';

    @Controllerr('users')
    export class UsersController {
      @Get()
      findAll(): string {
        return 'all users';
      }
    }
  `;

  const program = createInMemoryProgram(
    { 'stub.d.ts': STUB, 'main.ts': MAIN },
    ['stub.d.ts', 'main.ts'],
    {
      target: ts.ScriptTarget.ES2022,
      experimentalDecorators: true,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
    },
  );
  const checker = program.getTypeChecker();

  it("classifies the typo'd decorator as unverified, not mismatch", () => {
    const sourceFile = program.getSourceFile('main.ts');
    if (!sourceFile) throw new Error('missing main.ts');
    let classNode: ts.ClassDeclaration | undefined;
    ts.forEachChild(sourceFile, function visit(node) {
      if (ts.isClassDeclaration(node)) classNode = node;
      ts.forEachChild(node, visit);
    });
    if (!classNode) throw new Error('no class found');

    const decorators = getDecoratorInfos(classNode, checker);
    const typoDecorator = decorators.find((d) => d.name === 'Controllerr');
    expect(typoDecorator?.provenance).toBe('unverified');
    // And its resolvedName must never leak the compiler's internal "unknown
    // symbol" name — that was the secondary consequence of the original bug.
    expect(typoDecorator?.resolvedName).toBeUndefined();
  });

  it('is still not recognized as a controller (name-based fallback only matches the real name)', () => {
    const sourceFile = program.getSourceFile('main.ts');
    if (!sourceFile) throw new Error('missing main.ts');
    let classNode: ts.ClassDeclaration | undefined;
    ts.forEachChild(sourceFile, function visit(node) {
      if (ts.isClassDeclaration(node)) classNode = node;
      ts.forEachChild(node, visit);
    });
    if (!classNode) throw new Error('no class found');

    expect(getControllerInfo(classNode, checker)).toBeUndefined();
  });
});
