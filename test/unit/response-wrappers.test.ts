import { describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import { getDocumentationGaps, getDocumentedStatuses } from '../../src/core/documented.js';
import type { AnalysisOptions } from '../../src/core/types.js';
import { createInMemoryProgram } from '../helpers/in-memory-program.js';

const STUB = `
  declare module '@nestjs/swagger' {
    export interface ApiResponseOptions { status?: number | string; description?: string; }
    export function ApiResponse(options?: ApiResponseOptions): MethodDecorator & ClassDecorator;
    export function ApiOperation(options: { summary?: string }): MethodDecorator;
    export function ApiPermanentRedirectResponse(options?: ApiResponseOptions): MethodDecorator & ClassDecorator;
    export function ApiNotFoundResponse(options?: ApiResponseOptions): MethodDecorator & ClassDecorator;
  }
  declare module '@nestjs/common' {
    export function applyDecorators(...decorators: Array<ClassDecorator | MethodDecorator>): MethodDecorator & ClassDecorator;
  }
`;

const COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  experimentalDecorators: true,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
};

function options(extra: Partial<AnalysisOptions> = {}): AnalysisOptions {
  return {
    maxDepth: 2,
    rules: { 'documented-but-unreachable': false, 'unresolvable-status': false },
    treatDefaultAsWildcard: false,
    ignoreStatuses: [],
    ...extra,
  };
}

function methodOf(mainSource: string, methodName: string) {
  const program = createInMemoryProgram(
    { 'stub.d.ts': STUB, 'main.ts': mainSource },
    ['stub.d.ts', 'main.ts'],
    COMPILER_OPTIONS,
  );
  const sourceFile = program.getSourceFile('main.ts');
  if (!sourceFile) throw new Error('missing main.ts');
  let method: ts.MethodDeclaration | undefined;
  ts.forEachChild(sourceFile, function visit(node) {
    if (ts.isMethodDeclaration(node) && node.name.getText() === methodName) method = node;
    ts.forEachChild(node, visit);
  });
  if (!method) throw new Error(`method ${methodName} not found`);
  return { method, checker: program.getTypeChecker() };
}

function statuses(source: string, extra: Partial<AnalysisOptions> = {}): unknown[] {
  const { method, checker } = methodOf(source, 'm');
  return getDocumentedStatuses(method, checker, options(extra)).map((d) => d.status);
}

function gaps(source: string, extra: Partial<AnalysisOptions> = {}) {
  const { method, checker } = methodOf(source, 'm');
  return getDocumentationGaps(method, checker, options(extra));
}

const HEADER = `
  import { ApiResponse, ApiOperation, ApiPermanentRedirectResponse } from '@nestjs/swagger';
  import { applyDecorators } from '@nestjs/common';
`;

describe('wrapper decorators: automatic resolution', () => {
  it('resolves applyDecorators(ApiResponse({ status: 202 }))', () => {
    const source = `${HEADER}
      const Accepted = () => applyDecorators(ApiResponse({ status: 202 }));
      class C { @Accepted() m() {} }`;
    expect(statuses(source)).toEqual([202]);
  });

  it('resolves a function declaration wrapper and nested wrappers', () => {
    const source = `${HEADER}
      function Inner() { return applyDecorators(ApiResponse({ status: 404 })); }
      const Outer = () => applyDecorators(Inner(), ApiResponse({ status: 409 }));
      class C { @Outer() m() {} }`;
    expect(statuses(source)).toEqual([404, 409]);
  });

  it('forwards a literal argument into the swagger status', () => {
    const source = `${HEADER}
      const Doc = (status: number) => applyDecorators(ApiResponse({ status }));
      class C { @Doc(409) m() {} }`;
    expect(statuses(source)).toEqual([409]);
  });

  it('uses a parameter default when the argument is omitted', () => {
    const source = `${HEADER}
      const Doc = (status: number = 200) => applyDecorators(ApiResponse({ status }));
      class C { @Doc() m() {} }`;
    expect(statuses(source)).toEqual([200]);
  });

  it('selects the switch case for a bound argument, with default and break', () => {
    const source = `${HEADER}
      const Doc = (status: number = 200) => {
        let fn;
        switch (status) {
          case 308:
            fn = ApiPermanentRedirectResponse;
            break;
          case 404:
            fn = NotFound;
            break;
          default:
            fn = Ok;
            break;
        }
        return applyDecorators(ApiOperation({ summary: 'x' }), fn({ description: 'd' }));
      };
      declare const NotFound: (o?: object) => MethodDecorator;
      declare const Ok: (o?: object) => MethodDecorator;
      class C {
        @Doc(308) m() {}
        @Doc(500) other() {}
      }`;
    expect(statuses(source, { responseDecorators: { Ok: [200], NotFound: [404] } })).toEqual([308]);
    const { method, checker } = methodOf(source, 'other');
    const result = getDocumentedStatuses(
      method,
      checker,
      options({ responseDecorators: { Ok: [200], NotFound: [404] } }),
    );
    expect(result.map((d) => d.status)).toEqual([200]);
  });

  it('does not document a status the code never selects', () => {
    const source = `${HEADER}
      const Doc = (status: number = 200) => {
        if (status === 404) return applyDecorators(ApiResponse({ status: 404 }));
        return applyDecorators(ApiResponse({ status: 200 }));
      };
      class C { @Doc() m() {} }`;
    expect(statuses(source)).toEqual([200]);
  });
});

describe('wrapper decorators: configuration', () => {
  it('uses a configured status list for a non-swagger decorator', () => {
    const source = `${HEADER}
      declare const ApiCommon: () => MethodDecorator & ClassDecorator;
      @ApiCommon()
      class C { m() {} }`;
    expect(statuses(source, { responseDecorators: { ApiCommon: [400, 404, '5XX'] } })).toEqual([
      400,
      404,
      '5XX',
    ]);
  });

  it('config replaces the body of a wrapper it names', () => {
    const source = `${HEADER}
      const Doc = () => applyDecorators(ApiResponse({ status: 200 }));
      class C { @Doc() m() {} }`;
    expect(statuses(source, { responseDecorators: { Doc: [201] } })).toEqual([201]);
  });

  it('a configured name matching a swagger decorator is ignored', () => {
    const source = `${HEADER}
      class C { @ApiResponse({ status: 404 }) m() {} }`;
    expect(statuses(source, { responseDecorators: { ApiResponse: [500] } })).toEqual([404]);
  });
});

describe('wrapper decorators: refusing to guess', () => {
  it('reports a response-looking wrapper whose status depends on an unbound value', () => {
    const source = `${HEADER}
      const ApiMaybe = (status: number) => {
        switch (status) { case 1: return ApiResponse({ status: 200 }); default: return ApiResponse({ status: 404 }); }
      };
      declare const dynamic: number;
      class C { @ApiMaybe(dynamic) m() {} }`;
    expect(statuses(source)).toEqual([]);
    expect(gaps(source)).toEqual([
      expect.objectContaining({ decorator: 'ApiMaybe', reason: expect.stringContaining('switch') }),
    ]);
  });

  it('reports a loop as opaque', () => {
    const source = `${HEADER}
      const ApiAll = () => {
        const ds = [];
        for (const s of [400, 404]) ds.push(ApiResponse({ status: s }));
        return applyDecorators(...ds);
      };
      class C { @ApiAll() m() {} }`;
    expect(statuses(source)).toEqual([]);
    expect(gaps(source)).toEqual([expect.objectContaining({ decorator: 'ApiAll' })]);
  });

  it('stays silent about wrappers that are not about responses', () => {
    const source = `${HEADER}
      const Authenticated = () => applyDecorators(ApiOperation({ summary: 'x' }));
      const Perms = (...p: string[]) => { const ds: MethodDecorator[] = []; for (const x of p) ds.push(ApiOperation({ summary: x })); return applyDecorators(...ds); };
      class C { @Authenticated() @Perms('a') m() {} }`;
    expect(statuses(source)).toEqual([]);
    expect(gaps(source)).toEqual([]);
  });

  it('terminates on a recursive wrapper', () => {
    const source = `${HEADER}
      const ApiLoop = (): MethodDecorator => applyDecorators(ApiLoop(), ApiResponse({ status: 404 }));
      class C { @ApiLoop() m() {} }`;
    expect(statuses(source)).toEqual([404]);
  });

  it('a configured wrapper produces no gap', () => {
    const source = `${HEADER}
      declare const ApiCommon: () => MethodDecorator & ClassDecorator;
      class C { @ApiCommon() m() {} }`;
    expect(gaps(source, { responseDecorators: { ApiCommon: [404] } })).toEqual([]);
  });
});
