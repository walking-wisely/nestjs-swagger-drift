/**
 * Generates a synthetic, NestJS-shaped project for the Phase 5 perf
 * benchmark (PLAN §5: "perf pass on a 500-file synthetic project, target
 * under ~10s warm"). Lives under `scripts/` (not `test/fixtures/`)
 * deliberately: the ~500 generated files are never written into the repo or
 * committed — `test/perf/large-project.bench.ts` calls
 * `generatePerfFixture` into a fresh `os.tmpdir()` directory at benchmark
 * run time and deletes it afterward, so there is nothing here for `.
 * gitignore` to need to hide.
 *
 * Shape, mirroring `test/fixtures/status-diff` in miniature but multiplied
 * out: each generated controller has a small, deliberately mixed set of
 * handlers —
 *
 * - a direct `throw` (§4.1a),
 * - a one-hop service throw (§4.1b) into a PER-CONTROLLER service (so the
 *   call-graph memoization cache in `call-graph.ts` has many distinct
 *   symbols to hold, not just one — this is the shape that stresses the
 *   cache's steady-state size, not just its hit rate),
 * - a two-hop throw through a small set of SHARED repository classes
 *   (reused across every controller, the way a real app's persistence layer
 *   is shared) — this is the shape that stresses memoization's hit rate: a
 *   correctly-memoized run visits each shared repository method's body
 *   exactly once no matter how many of the 500 controllers call into it,
 *   which is the whole point of `call-graph.ts`'s `WeakMap`-keyed cache,
 * - a `@UseGuards(...)` handler against one of a small set of shared guard
 *   classes, and
 * - a fully documented, clean handler (the majority — most real endpoints
 *   are not drifted), so the benchmark also measures the "found nothing,
 *   still had to check everything" cost, not just the found-drift path.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const AMBIENT_NESTJS_COMMON = `
declare module '@nestjs/common' {
  export type PathType = string | string[];
  export function Controller(prefix?: PathType): ClassDecorator;
  export function Get(path?: PathType): MethodDecorator;
  export function Post(path?: PathType): MethodDecorator;
  export function Injectable(): ClassDecorator;
  export function UseGuards(...guards: unknown[]): MethodDecorator & ClassDecorator;
  export interface ExecutionContext { switchToHttp(): unknown; }
  export interface CanActivate { canActivate(context: ExecutionContext): boolean; }
  export class HttpException extends Error {
    constructor(response: string | Record<string, unknown>, status: number);
  }
  export class NotFoundException extends HttpException { constructor(message?: string); }
  export class ConflictException extends HttpException { constructor(message?: string); }
  export class UnauthorizedException extends HttpException { constructor(message?: string); }
}
`;

const AMBIENT_NESTJS_SWAGGER = `
declare module '@nestjs/swagger' {
  export interface ApiResponseOptions { status?: number; description?: string; }
  export function ApiOkResponse(options?: ApiResponseOptions): MethodDecorator & ClassDecorator;
  export function ApiNotFoundResponse(options?: ApiResponseOptions): MethodDecorator & ClassDecorator;
}
`;

const SHARED_REPOSITORY_COUNT = 5;
const SHARED_GUARD_COUNT = 3;

function repositoryFile(index: number): string {
  return `// Shared repository #${index} — called by every generated controller's two-hop handler.
import { Injectable, ConflictException } from '@nestjs/common';

@Injectable()
export class SharedRepository${index} {
  save(id: string): string {
    if (!id) throw new ConflictException('duplicate id');
    return id;
  }
}
`;
}

function guardFile(index: number): string {
  return `// Shared guard #${index}.
import { Injectable, UnauthorizedException } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';

@Injectable()
export class SharedGuard${index} implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (!context) throw new UnauthorizedException('no token');
    return true;
  }
}
`;
}

function serviceFile(controllerIndex: number, repoIndex: number): string {
  return `// Per-controller service for controller #${controllerIndex}.
import { Injectable, NotFoundException } from '@nestjs/common';
import { SharedRepository${repoIndex} } from './shared-repository-${repoIndex}.js';

@Injectable()
export class Service${controllerIndex} {
  constructor(private readonly repo: SharedRepository${repoIndex}) {}

  findOne(id: string): string {
    if (!id) throw new NotFoundException('not found');
    return id;
  }

  save(id: string): string {
    return this.repo.save(id);
  }
}
`;
}

function controllerFile(index: number, repoIndex: number, guardIndex: number): string {
  return `// Generated controller #${index}.
import { Controller, ConflictException, Get, Post, UseGuards } from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';
import { Service${index} } from './service-${index}.js';
import { SharedGuard${guardIndex} } from './shared-guard-${guardIndex}.js';

@Controller('resource-${index}')
export class Controller${index} {
  constructor(private readonly svc: Service${index}) {}

  // Direct throw, PLUS a one-hop service throw of a different status below.
  @Get(':id')
  findOne(id: string): string {
    if (id === 'taken') throw new ConflictException('id already taken');
    return this.svc.findOne(id);
  }

  // One-hop service throw.
  @Get(':id/detail')
  detail(id: string): string {
    return this.svc.findOne(id);
  }

  // Two-hop throw through a shared repository.
  @Post()
  create(id: string): string {
    return this.svc.save(id);
  }

  // Guard-gated handler.
  @UseGuards(SharedGuard${guardIndex})
  @Get('protected')
  protected_(): string {
    return 'ok';
  }

  // Fully documented, clean handler.
  @ApiOkResponse({ status: 200 })
  @Get('clean')
  clean(): string {
    return 'ok';
  }
}
`;
}

export interface PerfFixture {
  dir: string;
  tsconfigPath: string;
  controllerCount: number;
}

/** Writes a synthetic `controllerCount`-controller NestJS-shaped project into `outDir` (must already exist). */
export function generatePerfFixture(outDir: string, controllerCount = 500): PerfFixture {
  const srcDir = path.join(outDir, 'src');
  const typesDir = path.join(outDir, 'types');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.mkdirSync(typesDir, { recursive: true });

  fs.writeFileSync(path.join(typesDir, 'nestjs-common.d.ts'), AMBIENT_NESTJS_COMMON);
  fs.writeFileSync(path.join(typesDir, 'nestjs-swagger.d.ts'), AMBIENT_NESTJS_SWAGGER);

  for (let r = 0; r < SHARED_REPOSITORY_COUNT; r++) {
    fs.writeFileSync(path.join(srcDir, `shared-repository-${r}.ts`), repositoryFile(r));
  }
  for (let g = 0; g < SHARED_GUARD_COUNT; g++) {
    fs.writeFileSync(path.join(srcDir, `shared-guard-${g}.ts`), guardFile(g));
  }

  for (let i = 0; i < controllerCount; i++) {
    const repoIndex = i % SHARED_REPOSITORY_COUNT;
    const guardIndex = i % SHARED_GUARD_COUNT;
    fs.writeFileSync(path.join(srcDir, `service-${i}.ts`), serviceFile(i, repoIndex));
    fs.writeFileSync(
      path.join(srcDir, `controller-${i}.ts`),
      controllerFile(i, repoIndex, guardIndex),
    );
  }

  const tsconfigPath = path.join(outDir, 'tsconfig.json');
  fs.writeFileSync(
    tsconfigPath,
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          lib: ['ES2022'],
          module: 'nodenext',
          moduleResolution: 'nodenext',
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
          strict: true,
          skipLibCheck: true,
          noEmit: true,
        },
        include: ['src', 'types'],
      },
      undefined,
      2,
    ),
  );

  return { dir: outDir, tsconfigPath, controllerCount };
}
