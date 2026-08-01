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

    const findings = collectCallGraphStatuses(handler, ctx);
    expect(findings).toHaveLength(0); // OrgService.create itself throws nothing directly
  });

  it('maxDepth: 2 (the default) reaches the two-hop status', () => {
    const program = programWithMain(TWO_HOP_SOURCE);
    const ctx = createAnalysisContext(program, defaultOptions({ maxDepth: 2 }));
    const handler = findMethod(program, 'main.ts', 'OrgController', 'create');

    const findings = collectCallGraphStatuses(handler, ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.resolved.status).toBe(409);
  });

  it('maxDepth: 0 traverses nothing at all', () => {
    const program = programWithMain(TWO_HOP_SOURCE);
    const ctx = createAnalysisContext(program, defaultOptions({ maxDepth: 0 }));
    const handler = findMethod(program, 'main.ts', 'OrgController', 'create');

    expect(collectCallGraphStatuses(handler, ctx)).toHaveLength(0);
  });
});

describe('collectCallGraphStatuses — via path contents', () => {
  it('carries a two-hop via path with the right names, in order', () => {
    const program = programWithMain(TWO_HOP_SOURCE);
    const ctx = createAnalysisContext(program, defaultOptions());
    const handler = findMethod(program, 'main.ts', 'OrgController', 'create');

    const findings = collectCallGraphStatuses(handler, ctx);
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
    const findings = collectCallGraphStatuses(handler, ctx);
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
    const first = collectCallGraphStatuses(handlerA, ctx);
    const afterFirst = __getCallGraphMemoStatsForTesting().computed;
    expect(afterFirst).toBeGreaterThan(0); // OrgService.create + OrgRepository.save were computed

    const second = collectCallGraphStatuses(handlerB, ctx);
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

    expect(collectCallGraphStatuses(handler, ctx)).toHaveLength(0);
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

    expect(collectCallGraphStatuses(handler, ctx)).toHaveLength(0);
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

    expect(collectCallGraphStatuses(handler, ctx)).toHaveLength(0);
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

    const findings = collectCallGraphStatuses(handler, ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.resolved.status).toBe(404);
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

    expect(collectCallGraphStatuses(handler, ctx)).toHaveLength(0);
  });
});
