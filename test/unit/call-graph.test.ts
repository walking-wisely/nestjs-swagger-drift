import { describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import {
  collectCallGraphStatuses,
  __getCallGraphMemoStatsForTesting,
  __resetCallGraphMemoStatsForTesting,
} from '../../src/core/call-graph.js';
import { createAnalysisContext } from '../../src/core/analyze.js';
import type { AnalysisOptions } from '../../src/core/types.js';
import { createInMemoryProgram } from '../helpers/in-memory-program.js';

// Everything lives in a single in-memory file per test (rather than several
// files wired together with relative imports): the in-memory compiler host
// only needs to resolve `@nestjs/common` (an ambient `declare module`, not a
// real file lookup), so single-file keeps these tests independent of the
// host's relative-module-resolution behavior. Genuine cross-file resolution
// (the shape PLAN §4.4's sample output actually shows) is exercised by the
// on-disk `status-diff`/`no-false-positives` fixtures instead, via
// `test/integration/analyze.test.ts`.
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
  }
`;

const COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  experimentalDecorators: true,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
};

function defaultOptions(overrides: Partial<AnalysisOptions> = {}): AnalysisOptions {
  return {
    maxDepth: 2,
    rules: { 'documented-but-unreachable': false, 'unresolvable-status': false },
    treatDefaultAsWildcard: false,
    ignoreStatuses: [],
    ...overrides,
  };
}

function findMethod(
  program: ts.Program,
  fileName: string,
  className: string,
  methodName: string,
): ts.MethodDeclaration {
  const sourceFile = program.getSourceFile(fileName);
  if (!sourceFile) throw new Error(`missing ${fileName}`);

  let found: ts.MethodDeclaration | undefined;
  ts.forEachChild(sourceFile, function visit(node) {
    if (
      ts.isMethodDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === methodName &&
      ts.isClassDeclaration(node.parent) &&
      node.parent.name?.text === className
    ) {
      found = node;
    }
    ts.forEachChild(node, visit);
  });
  if (!found) throw new Error(`${className}.${methodName} not found in ${fileName}`);
  return found;
}

function programWithMain(source: string): ts.Program {
  return createInMemoryProgram(
    { 'stub.d.ts': STUB, 'main.ts': source },
    ['stub.d.ts', 'main.ts'],
    COMPILER_OPTIONS,
  );
}

/** A handler -> service -> repository chain, for depth/via tests. */
const TWO_HOP_SOURCE = `
  import { ConflictException } from '@nestjs/common';

  export class OrgRepository {
    save(name: string): string {
      if (!name) throw new ConflictException('org exists');
      return 'saved';
    }
  }

  export class OrgService {
    constructor(private readonly repo: OrgRepository) {}
    create(name: string): string {
      return this.repo.save(name);
    }
  }

  export class OrgController {
    constructor(private readonly orgs: OrgService) {}
    create(name: string): string {
      return this.orgs.create(name);
    }
  }
`;

describe('collectCallGraphStatuses — depth bounding', () => {
  it('maxDepth: 1 finds the one-hop status but not the two-hop status', () => {
    const program = programWithMain(TWO_HOP_SOURCE);
    const ctx = createAnalysisContext(program, defaultOptions({ maxDepth: 1 }));
    const handler = findMethod(program, 'main.ts', 'OrgController', 'create');

    const { findings } = collectCallGraphStatuses(handler, ctx);
    expect(findings).toHaveLength(0); // OrgService.create itself throws nothing directly
  });

  it('maxDepth: 2 (the default) reaches the two-hop status', () => {
    const program = programWithMain(TWO_HOP_SOURCE);
    const ctx = createAnalysisContext(program, defaultOptions({ maxDepth: 2 }));
    const handler = findMethod(program, 'main.ts', 'OrgController', 'create');

    const { findings } = collectCallGraphStatuses(handler, ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.resolved.status).toBe(409);
  });

  it('maxDepth: 0 traverses nothing at all', () => {
    const program = programWithMain(TWO_HOP_SOURCE);
    const ctx = createAnalysisContext(program, defaultOptions({ maxDepth: 0 }));
    const handler = findMethod(program, 'main.ts', 'OrgController', 'create');

    expect(collectCallGraphStatuses(handler, ctx).findings).toHaveLength(0);
  });
});

describe('collectCallGraphStatuses — same-class hops are free', () => {
  // Adversarial-testing finding: a private same-class helper sits BETWEEN
  // the handler's own service call and the repository throw
  // (`OrgController.create` → `OrgService.create` → `OrgService#ensureReady`
  // (private) → `OrgRepository.save`) — three call sites, but only one
  // genuine class-to-class crossing beyond the handler's own call
  // (`OrgService` → `OrgRepository`). At the default `maxDepth: 2` this must
  // resolve exactly like `TWO_HOP_SOURCE` (no private helper in the middle)
  // does — the private hop must not eat depth budget the repository call
  // needs.
  const SAME_CLASS_HELPER_SOURCE = `
    import { ConflictException } from '@nestjs/common';

    export class OrgRepository {
      save(name: string): string {
        if (!name) throw new ConflictException('org exists');
        return 'saved';
      }
    }

    export class OrgService {
      constructor(private readonly repo: OrgRepository) {}
      private ensureReady(name: string): void {
        if (!name) throw new Error('unreachable in this test');
      }
      create(name: string): string {
        this.ensureReady(name);
        return this.repo.save(name);
      }
    }

    export class OrgController {
      constructor(private readonly orgs: OrgService) {}
      create(name: string): string {
        return this.orgs.create(name);
      }
    }
  `;

  it('reaches the repository throw through a private same-class helper at maxDepth: 2', () => {
    const program = programWithMain(SAME_CLASS_HELPER_SOURCE);
    const ctx = createAnalysisContext(program, defaultOptions({ maxDepth: 2 }));
    const handler = findMethod(program, 'main.ts', 'OrgController', 'create');

    const { findings } = collectCallGraphStatuses(handler, ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.resolved.status).toBe(409);
  });

  it('still requires the one genuine cross-class hop (maxDepth: 1 does not reach it)', () => {
    const program = programWithMain(SAME_CLASS_HELPER_SOURCE);
    const ctx = createAnalysisContext(program, defaultOptions({ maxDepth: 1 }));
    const handler = findMethod(program, 'main.ts', 'OrgController', 'create');

    // maxDepth: 1 reaches OrgService.create (hop 1) and, for free, its own
    // private helper — but the repository is still a second, genuine
    // cross-class hop this budget can't afford.
    expect(collectCallGraphStatuses(handler, ctx).findings).toHaveLength(0);
  });

  it('a same-class chain of THREE private helpers before the repository still resolves at maxDepth: 2', () => {
    const program = programWithMain(`
      import { NotFoundException } from '@nestjs/common';

      export class WidgetsRepository {
        find(id: string): string {
          if (!id) throw new NotFoundException('widget');
          return 'widget';
        }
      }

      export class WidgetsService {
        constructor(private readonly repo: WidgetsRepository) {}
        private stepA(id: string): string { return this.stepB(id); }
        private stepB(id: string): string { return this.stepC(id); }
        private stepC(id: string): string { return this.repo.find(id); }
        get(id: string): string {
          return this.stepA(id);
        }
      }

      export class WidgetsController {
        constructor(private readonly svc: WidgetsService) {}
        get(id: string): string {
          return this.svc.get(id);
        }
      }
    `);
    const ctx = createAnalysisContext(program, defaultOptions({ maxDepth: 2 }));
    const handler = findMethod(program, 'main.ts', 'WidgetsController', 'get');

    const { findings } = collectCallGraphStatuses(handler, ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.resolved.status).toBe(404);
  });

  it('a cross-class chain of the same length is NOT free (sanity control)', () => {
    // Same shape as the three-private-helpers test, but each "helper" is on
    // its own class — every hop is a genuine crossing, so maxDepth: 2 must
    // NOT reach the repository throw (unlike the private-helper version above).
    const program = programWithMain(`
      import { NotFoundException } from '@nestjs/common';

      export class WidgetsRepository {
        find(id: string): string {
          if (!id) throw new NotFoundException('widget');
          return 'widget';
        }
      }
      export class StepC {
        constructor(private readonly repo: WidgetsRepository) {}
        run(id: string): string { return this.repo.find(id); }
      }
      export class StepB {
        constructor(private readonly c: StepC) {}
        run(id: string): string { return this.c.run(id); }
      }
      export class StepA {
        constructor(private readonly b: StepB) {}
        run(id: string): string { return this.b.run(id); }
      }
      export class WidgetsController {
        constructor(private readonly a: StepA) {}
        get(id: string): string {
          return this.a.run(id);
        }
      }
    `);
    const ctx = createAnalysisContext(program, defaultOptions({ maxDepth: 2 }));
    const handler = findMethod(program, 'main.ts', 'WidgetsController', 'get');

    expect(collectCallGraphStatuses(handler, ctx).findings).toHaveLength(0);
  });

  // Code-review finding, verified: with same-class hops free and NO separate
  // bound, a class whose methods fan out into several same-class helpers
  // each turns this traversal into enumerating every simple path through
  // that fan-out — exponential in the fan-out width, unbounded by
  // `maxDepth`. Confirmed empirically to crash a real process past ~28
  // methods at fan-out 3. `SAME_CLASS_HOP_BUDGET` bounds it: a same-class
  // chain longer than that budget starts costing depth again, exactly like
  // a cross-class hop. This test's shape (30 methods, each calling the next
  // 3) is the exact reported crash shape, at a size that used to be well
  // past the crash point.
  it('a wide same-class fan-out does not explode combinatorially (DoS regression)', () => {
    const methodCount = 30;
    let methods = '';
    for (let i = 0; i < methodCount; i++) {
      const calls = [i + 1, i + 2, i + 3]
        .filter((j) => j < methodCount)
        .map((j) => `this.m${j}()`)
        .join('; ');
      methods += `  private m${i}(): void { ${calls}; }\n`;
    }
    const program = programWithMain(`
      import { NotFoundException } from '@nestjs/common';
      export class FanOutService {
${methods}
        entry(): void {
          this.m0();
        }
      }
      export class FanOutController {
        constructor(private readonly svc: FanOutService) {}
        get(): void {
          this.svc.entry();
        }
      }
    `);
    const ctx = createAnalysisContext(program, defaultOptions({ maxDepth: 2 }));
    const handler = findMethod(program, 'main.ts', 'FanOutController', 'get');

    const start = Date.now();
    const { findings } = collectCallGraphStatuses(handler, ctx);
    const elapsedMs = Date.now() - start;

    // Nothing in the fan-out throws at all — the point is purely that
    // walking it completes fast and doesn't enumerate an exponential number
    // of duplicate (empty) paths.
    expect(elapsedMs).toBeLessThan(5000);
    expect(findings).toHaveLength(0);
  });
});

describe('collectCallGraphStatuses — via path contents', () => {
  it('carries a two-hop via path with the right names, in order', () => {
    const program = programWithMain(TWO_HOP_SOURCE);
    const ctx = createAnalysisContext(program, defaultOptions());
    const handler = findMethod(program, 'main.ts', 'OrgController', 'create');

    const { findings } = collectCallGraphStatuses(handler, ctx);
    expect(findings).toHaveLength(1);
    const source = findings[0]?.source;
    expect(source?.kind).toBe('service-throw');
    if (source?.kind !== 'service-throw') throw new Error('expected a service-throw source');
    expect(source.via.map((hop) => hop.name)).toEqual(['OrgService.create', 'OrgRepository.save']);
    // Each hop carries a distinct call-site node (PLAN §4.4: per-hop location).
    expect(source.via[0]?.node).not.toBe(source.via[1]?.node);
    expect(source.exception).toBe('ConflictException');
  });
});

describe('collectCallGraphStatuses — cycle guard', () => {
  it('terminates on mutually recursive services instead of looping forever', () => {
    const program = programWithMain(`
      import { NotFoundException } from '@nestjs/common';

      export class ServiceA {
        a(x: boolean): string {
          if (x) throw new NotFoundException('a');
          return new ServiceB().b(x);
        }
      }
      export class ServiceB {
        b(x: boolean): string {
          return new ServiceA().a(x);
        }
      }
      export class RecursiveController {
        constructor(private readonly svc: ServiceA) {}
        get(x: boolean): string {
          return this.svc.a(x);
        }
      }
    `);
    const ctx = createAnalysisContext(program, defaultOptions({ maxDepth: 50 }));
    const handler = findMethod(program, 'main.ts', 'RecursiveController', 'get');

    // Must return (not hang/overflow) even with a generous maxDepth, and
    // must still find the real, reachable 404 exactly once.
    const { findings } = collectCallGraphStatuses(handler, ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.resolved.status).toBe(404);
  });
});

describe('collectCallGraphStatuses — memoization', () => {
  it('computes a shared service exactly once across two handlers sharing a cache', () => {
    // Two distinct "handlers" that both call into the same OrgService/OrgRepository chain.
    const program = programWithMain(`
      ${TWO_HOP_SOURCE}
      export class SecondController {
        constructor(private readonly orgs: OrgService) {}
        create(name: string): string {
          return this.orgs.create(name);
        }
      }
    `);
    const ctx = createAnalysisContext(program, defaultOptions());
    const handlerA = findMethod(program, 'main.ts', 'OrgController', 'create');
    const handlerB = findMethod(program, 'main.ts', 'SecondController', 'create');

    __resetCallGraphMemoStatsForTesting();
    const first = collectCallGraphStatuses(handlerA, ctx).findings;
    const afterFirst = __getCallGraphMemoStatsForTesting().computed;
    expect(afterFirst).toBeGreaterThan(0); // OrgService.create + OrgRepository.save were computed

    const second = collectCallGraphStatuses(handlerB, ctx).findings;
    const afterSecond = __getCallGraphMemoStatsForTesting().computed;

    // Same underlying OrgService/OrgRepository symbols reached via a
    // different handler + shared `ctx.cache` must not be recomputed.
    expect(afterSecond).toBe(afterFirst);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
  });

  it('a fresh AnalysisContext (no shared cache) recomputes from scratch', () => {
    const program = programWithMain(TWO_HOP_SOURCE);
    const handler = findMethod(program, 'main.ts', 'OrgController', 'create');

    __resetCallGraphMemoStatsForTesting();
    const ctxOne = createAnalysisContext(program, defaultOptions());
    collectCallGraphStatuses(handler, ctxOne);
    const afterOne = __getCallGraphMemoStatsForTesting().computed;
    expect(afterOne).toBeGreaterThan(0);

    // A brand new Program (and therefore a brand new, unshared cache)
    // recomputes rather than reusing the previous run's entries.
    const programTwo = programWithMain(TWO_HOP_SOURCE);
    const handlerTwo = findMethod(programTwo, 'main.ts', 'OrgController', 'create');
    const ctxTwo = createAnalysisContext(programTwo, defaultOptions());
    collectCallGraphStatuses(handlerTwo, ctxTwo);
    const afterTwo = __getCallGraphMemoStatsForTesting().computed;
    expect(afterTwo).toBeGreaterThan(afterOne);
  });
});

describe('collectCallGraphStatuses — ambiguity guards', () => {
  it('a union-typed callee (two different implementations) contributes nothing', () => {
    const program = programWithMain(`
      import { NotFoundException, ConflictException } from '@nestjs/common';

      export class ServiceA {
        find(): string {
          throw new NotFoundException('a');
        }
      }
      export class ServiceB {
        find(): string {
          throw new ConflictException('b');
        }
      }
      export class UnionController {
        constructor(private readonly svc: ServiceA | ServiceB) {}
        get(): string {
          return this.svc.find();
        }
      }
    `);
    const ctx = createAnalysisContext(program, defaultOptions());
    const handler = findMethod(program, 'main.ts', 'UnionController', 'get');

    expect(collectCallGraphStatuses(handler, ctx).findings).toHaveLength(0);
  });

  it('an interface-typed dependency (no body to walk) contributes nothing', () => {
    const program = programWithMain(`
      import { NotFoundException } from '@nestjs/common';

      export interface WidgetsRepo {
        find(): string;
      }
      export class WidgetsRepoImpl implements WidgetsRepo {
        find(): string {
          throw new NotFoundException('widget');
        }
      }
      export class InterfaceController {
        constructor(private readonly repo: WidgetsRepo) {}
        get(): string {
          return this.repo.find();
        }
      }
    `);
    const ctx = createAnalysisContext(program, defaultOptions());
    const handler = findMethod(program, 'main.ts', 'InterfaceController', 'get');

    expect(collectCallGraphStatuses(handler, ctx).findings).toHaveLength(0);
  });
});

describe('collectCallGraphStatuses — try/catch suppression at the call site', () => {
  it('a call wrapped in a swallowing try/catch contributes nothing', () => {
    const program = programWithMain(`
      import { NotFoundException } from '@nestjs/common';

      export class WidgetsService {
        find(): string {
          throw new NotFoundException('widget');
        }
      }
      export class SwallowedController {
        constructor(private readonly svc: WidgetsService) {}
        get(): string | null {
          try {
            return this.svc.find();
          } catch {
            return null;
          }
        }
      }
    `);
    const ctx = createAnalysisContext(program, defaultOptions());
    const handler = findMethod(program, 'main.ts', 'SwallowedController', 'get');

    expect(collectCallGraphStatuses(handler, ctx).findings).toHaveLength(0);
  });

  it('the same call OUTSIDE a try/catch does contribute a finding (sanity control)', () => {
    const program = programWithMain(`
      import { NotFoundException } from '@nestjs/common';

      export class WidgetsService {
        find(): string {
          throw new NotFoundException('widget');
        }
      }
      export class PlainController {
        constructor(private readonly svc: WidgetsService) {}
        get(): string {
          return this.svc.find();
        }
      }
    `);
    const ctx = createAnalysisContext(program, defaultOptions());
    const handler = findMethod(program, 'main.ts', 'PlainController', 'get');

    const { findings } = collectCallGraphStatuses(handler, ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.resolved.status).toBe(404);
  });
});

describe('collectCallGraphStatuses — unresolved throws (Phase 5 review, finding #6)', () => {
  it('surfaces an unresolvable throw reached through the call graph, with its via path', () => {
    const program = programWithMain(`
      import { HttpException } from '@nestjs/common';

      export class FlakyService {
        check(id: string): string {
          const dynamicStatus = id.length; // not a literal
          if (!id) throw new HttpException('bad id', dynamicStatus);
          return 'ok';
        }
      }
      export class FlakyController {
        constructor(private readonly svc: FlakyService) {}
        get(id: string): string {
          return this.svc.check(id);
        }
      }
    `);
    const ctx = createAnalysisContext(program, defaultOptions());
    const handler = findMethod(program, 'main.ts', 'FlakyController', 'get');

    const { findings, unresolvedThrows } = collectCallGraphStatuses(handler, ctx);
    expect(findings).toHaveLength(0); // nothing RESOLVED here
    expect(unresolvedThrows).toHaveLength(1);
    expect(unresolvedThrows[0]?.via.map((hop) => hop.name)).toEqual(['FlakyService.check']);
    expect(unresolvedThrows[0]?.reason.length).toBeGreaterThan(0);
  });

  it('a resolvable direct throw in the same body is unaffected (sanity control)', () => {
    const program = programWithMain(TWO_HOP_SOURCE);
    const ctx = createAnalysisContext(program, defaultOptions());
    const handler = findMethod(program, 'main.ts', 'OrgController', 'create');

    const { findings, unresolvedThrows } = collectCallGraphStatuses(handler, ctx);
    expect(findings).toHaveLength(1);
    expect(unresolvedThrows).toHaveLength(0);
  });
});

describe('collectCallGraphStatuses — node_modules exclusion', () => {
  it('a call into an ambient (node_modules-shaped) module contributes nothing', () => {
    const program = createInMemoryProgram(
      {
        'stub.d.ts': STUB,
        'orm-stub.d.ts': `
          declare module 'third-party-orm' {
            export class Repository {
              find(): string;
            }
          }
        `,
        'main.ts': `
          import { Repository } from 'third-party-orm';
          export class ThirdPartyController {
            private readonly repo = new Repository();
            get(): string {
              return this.repo.find();
            }
          }
        `,
      },
      ['stub.d.ts', 'orm-stub.d.ts', 'main.ts'],
      COMPILER_OPTIONS,
    );
    const ctx = createAnalysisContext(program, defaultOptions());
    const handler = findMethod(program, 'main.ts', 'ThirdPartyController', 'get');

    expect(collectCallGraphStatuses(handler, ctx).findings).toHaveLength(0);
  });
});
