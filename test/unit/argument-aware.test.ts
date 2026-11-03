import { describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import { collectCallGraphStatuses } from '../../src/core/call-graph.js';
import { createAnalysisContext } from '../../src/core/analyze.js';
import {
  evaluateTruthiness,
  guaranteeEnv,
  type ArgEnv,
  type ConstValue,
} from '../../src/core/const-eval.js';
import type { AnalysisOptions } from '../../src/core/types.js';
import { createInMemoryProgram } from '../helpers/in-memory-program.js';

const STUB = `
  declare module '@nestjs/common' {
    export class HttpException extends Error {
      constructor(response: string, status: number);
    }
    export class UnauthorizedException extends HttpException {
      constructor(message?: string);
    }
  }
`;

const OPTIONS: AnalysisOptions = {
  maxDepth: 4,
  rules: { 'documented-but-unreachable': false, 'unresolvable-status': false },
  treatDefaultAsWildcard: false,
  ignoreStatuses: [],
};

function statusesFor(
  source: string,
  handlerName = 'handler',
  handlerEnv: ArgEnv = new Map(),
): number[] {
  const program = createInMemoryProgram(
    { 'stub.d.ts': STUB, 'main.ts': source },
    ['stub.d.ts', 'main.ts'],
    {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: true,
    },
  );
  const sourceFile = program.getSourceFile('main.ts')!;
  let handler: ts.MethodDeclaration | undefined;
  ts.forEachChild(sourceFile, function visit(node) {
    if (
      ts.isMethodDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === handlerName
    ) {
      handler = node;
    }
    ts.forEachChild(node, visit);
  });
  const ctx = createAnalysisContext(program, OPTIONS);
  return collectCallGraphStatuses(handler!, ctx, handlerEnv).findings.map((f) => f.resolved.status);
}

const IMPORT = `import { UnauthorizedException } from '@nestjs/common';`;

describe('call-graph: call-site arguments decide flag-guarded throws', () => {
  const lib = `
    ${IMPORT}
    export class Ctx {
      static user(throwError?: boolean): string | null {
        if (throwError) throw new UnauthorizedException('no user');
        return null;
      }
    }
  `;

  it('skips a throw guarded by an omitted optional flag', () => {
    expect(statusesFor(`${lib} export class C { handler() { return Ctx.user(); } }`)).toEqual([]);
  });

  it('skips a throw guarded by a literal false', () => {
    expect(statusesFor(`${lib} export class C { handler() { return Ctx.user(false); } }`)).toEqual(
      [],
    );
  });

  it('keeps the throw when the flag is a literal true', () => {
    expect(statusesFor(`${lib} export class C { handler() { return Ctx.user(true); } }`)).toEqual([
      401,
    ]);
  });

  it('keeps the throw when the flag is not a constant', () => {
    expect(
      statusesFor(`${lib} export class C { handler(flag: boolean) { return Ctx.user(flag); } }`),
    ).toEqual([401]);
  });

  it('keeps the throw when an argument is spread', () => {
    expect(
      statusesFor(`${lib} export class C { handler(a: [boolean]) { return Ctx.user(...a); } }`),
    ).toEqual([401]);
  });

  it('follows a flag forwarded through a wrapper', () => {
    const wrapped = `
      ${lib}
      export class W {
        static has(strict?: boolean) { return Ctx.user(strict); }
      }
    `;
    expect(statusesFor(`${wrapped} export class C { handler() { return W.has(); } }`)).toEqual([]);
    expect(statusesFor(`${wrapped} export class C { handler() { return W.has(true); } }`)).toEqual([
      401,
    ]);
  });

  it('uses a literal default value for an omitted parameter', () => {
    const src = `
      ${IMPORT}
      export class S {
        run(strict = true) { if (strict) throw new UnauthorizedException('x'); }
        lax(strict = false) { if (strict) throw new UnauthorizedException('x'); }
      }
      export class C {
        constructor(private s: S) {}
        handler() { return this.s.run(); }
        other() { return this.s.lax(); }
      }
    `;
    expect(statusesFor(src, 'handler')).toEqual([401]);
    expect(statusesFor(src, 'other')).toEqual([]);
  });

  it('does not bind a parameter that the callee reassigns', () => {
    const src = `
      ${IMPORT}
      export class S {
        run(strict?: boolean) { strict = this.compute(); if (strict) throw new UnauthorizedException('x'); }
        compute(): boolean { return Math.random() > 0.5; }
      }
      export class C { constructor(private s: S) {} handler() { return this.s.run(false); } }
    `;
    expect(statusesFor(src)).toEqual([401]);
  });

  it('does not bind a parameter shadowed by a local declaration', () => {
    const src = `
      ${IMPORT}
      export class S {
        run(strict?: boolean) { { const strict = Math.random() > 0.5; if (strict) throw new UnauthorizedException('x'); } }
      }
      export class C { constructor(private s: S) {} handler() { return this.s.run(false); } }
    `;
    expect(statusesFor(src)).toEqual([401]);
  });

  it('evaluates each call path independently when the same callee is reached with different flags', () => {
    const src = `
      ${lib}
      export class C {
        handler() { Ctx.user(); return Ctx.user(true); }
      }
    `;
    expect(statusesFor(src)).toEqual([401]);
  });

  it('treats the rest of the block as unreachable after a decided early return', () => {
    const src = `
      ${IMPORT}
      export class S {
        run(skip?: boolean) { if (!skip) return; throw new UnauthorizedException('x'); }
      }
      export class C { constructor(private s: S) {} handler() { return this.s.run(); } }
    `;
    expect(statusesFor(src)).toEqual([]);
  });
});

describe('const-eval: evaluateTruthiness', () => {
  function evalExpr(code: string, bindings: Record<string, ConstValue> = {}): boolean | undefined {
    const file = ts.createSourceFile('e.ts', `(${code});`, ts.ScriptTarget.ES2022, true);
    const stmt = file.statements[0] as ts.ExpressionStatement;
    const env: ArgEnv = new Map(Object.entries(bindings));
    return evaluateTruthiness(stmt.expression, env);
  }
  const T: ConstValue = { kind: 'bool', value: true };
  const F: ConstValue = { kind: 'bool', value: false };
  const U: ConstValue = { kind: 'undefined' };

  it.each([
    ['true', {}, true],
    ['false', {}, false],
    ['0', {}, false],
    ['"x"', {}, true],
    ['undefined', {}, false],
    ['null', {}, false],
    ['x', { x: T }, true],
    ['x', { x: U }, false],
    ['x', {}, undefined],
    ['!x', { x: F }, true],
    ['!x', {}, undefined],
    ['x && y', { x: F }, false],
    ['x && y', { x: T }, undefined],
    ['x && y', { x: T, y: T }, true],
    ['x || y', { x: T }, true],
    ['x || y', { x: F }, undefined],
    ['x === undefined', { x: U }, true],
    ['x === undefined', {}, undefined],
    ['x == null', { x: U }, true],
    ['x !== true', { x: F }, true],
    ['o.flag', {}, undefined],
    ['f()', {}, undefined],
  ])('%s with %j -> %s', (code, bindings, expected) => {
    expect(evalExpr(code, bindings as Record<string, ConstValue>)).toBe(expected);
  });
});

describe('call-graph: static argument types decide typeof guards', () => {
  const lib = `
    ${IMPORT}
    export class Svc {
      update(id: string | { name: string }): void {
        if (typeof id === 'object') {
          throw new UnauthorizedException('object branch');
        }
      }
      forward(id: string | { name: string }): void {
        this.update(id);
      }
    }
  `;

  it('skips the object branch when the argument is statically a string', () => {
    const src = `${lib}
      export class C {
        constructor(private svc: Svc) {}
        handler(id: string) { this.svc.update(id); }
      }`;
    expect(statusesFor(src)).toEqual([]);
  });

  it('keeps the throw when the argument may be an object', () => {
    const src = `${lib}
      export class C {
        constructor(private svc: Svc) {}
        handler(id: string | { name: string }) { this.svc.update(id); }
      }`;
    expect(statusesFor(src)).toEqual([401]);
  });

  it('forwards the fact through an intermediate call', () => {
    const src = `${lib}
      export class C {
        constructor(private svc: Svc) {}
        handler(id: string) { this.svc.forward(id); }
      }`;
    expect(statusesFor(src)).toEqual([]);
  });

  it('does not decide when the type is any', () => {
    const src = `${lib}
      export class C {
        constructor(private svc: Svc) {}
        handler(id: any) { this.svc.update(id); }
      }`;
    expect(statusesFor(src)).toEqual([401]);
  });
});

describe('call-graph: calls a guard guarantees to be truthy', () => {
  const lib = `
    ${IMPORT}
    export class RequestContext {
      static currentTenantId(): string | null { return null; }
    }
    export class Svc {
      direct(): void {
        const tenantId = RequestContext.currentTenantId();
        if (!tenantId) throw new UnauthorizedException('no tenant');
      }
      fallback(input: { tenantId?: string }): void {
        const tenantId = RequestContext.currentTenantId() || input.tenantId;
        if (!tenantId) throw new UnauthorizedException('no tenant');
      }
      inline(): void {
        if (!RequestContext.currentTenantId()) throw new UnauthorizedException('no tenant');
      }
      forwarded(): void {
        this.check(RequestContext.currentTenantId());
      }
      check(tenantId: string | null): void {
        if (!tenantId) throw new UnauthorizedException('no tenant');
      }
    }
  `;
  const guaranteed = guaranteeEnv(['RequestContext.currentTenantId']);
  const handlerFor = (method: string, args = '') => `${lib}
    export class C {
      constructor(private svc: Svc) {}
      handler() { this.svc.${method}(${args}); }
    }`;

  it.each([
    ['direct', ''],
    ['fallback', '{}'],
    ['inline', ''],
    ['forwarded', ''],
  ])('treats the %s tenant check as dead when the guard guarantees it', (method, args) => {
    expect(statusesFor(handlerFor(method, args), 'handler', guaranteed)).toEqual([]);
  });

  it.each([
    ['direct', ''],
    ['fallback', '{}'],
    ['inline', ''],
    ['forwarded', ''],
  ])('keeps the %s tenant check without the guarantee', (method, args) => {
    expect(statusesFor(handlerFor(method, args))).toEqual([401]);
  });

  it('does not extend the guarantee to other calls', () => {
    const other = guaranteeEnv(['RequestContext.currentUserId']);
    expect(statusesFor(handlerFor('direct'), 'handler', other)).toEqual([401]);
  });
});
