/**
 * Core data model for the analysis engine.
 *
 * Transcribed from PLAN.md §3.1, then extended per Phase 0 review (see
 * PUBLISHING.md / review notes for the AnalysisContext and StatusSource
 * changes). This module contains type definitions only — no runtime logic.
 * Runtime logic (decorator reading, throw resolution, the call graph,
 * `analyzeHandler`) lands in later phases.
 *
 * Hard rule (PLAN.md §3): nothing under `core/` may import from `cli/` or
 * `eslint/`, or touch anything from Node (`process`, `fs`, `console`, or any
 * other `node:*` built-in).
 */

import type * as ts from 'typescript';

/**
 * Where a producible status code was discovered.
 */
export type StatusSource =
  | {
      /** A direct `throw` statement inside the handler body. */
      kind: 'throw';
      node: ts.Node;
      /** Exception class name, e.g. `'NotFoundException'`. */
      exception: string;
    }
  | {
      /** A throw discovered by recursing into a method the handler calls. */
      kind: 'service-throw';
      node: ts.Node;
      exception: string;
      /**
       * Call path, e.g. `[{ name: 'UsersService.create', node }, { name:
       * 'OrgRepository.findOne', node }]`. Each hop carries its own node so
       * PLAN §4.4's report can print a location per hop:
       *
       *   404 NotFoundException
       *      └ UsersService.create → OrgRepository.findOne  src/org/org.repository.ts:31
       *
       * PLAN §3.1 originally typed this as `via: string[]` (names only),
       * which can't produce that per-hop location — §4.4 is the sample
       * output we need to satisfy, so this type follows §4.4 over the
       * literal §3.1 prose.
       */
      via: Array<{ name: string; node: ts.Node }>;
    }
  | {
      /** A status code NestJS produces without an explicit throw. */
      kind: 'implicit';
      node: ts.Node;
      reason: 'validation-pipe' | 'guard' | 'success';
    };

/**
 * The outcome of resolving a single producible status: either a concrete
 * status code (with a confidence, since PLAN §4.2 step 4 — a constructor
 * default literal — is explicitly "low confidence"), or `unknown` with a
 * human-readable reason (PLAN §4.2 step 5, e.g. a non-literal status
 * expression in `super(msg, someVar)`).
 *
 * Kept as its own discriminated union rather than folded into
 * `ProducibleStatus` so `resolved.status` is only reachable after narrowing
 * on `kind === 'resolved'`. This does not affect `Finding`'s own
 * `status: number` field on `undocumented-status` — that field is populated
 * by the future diff logic (PLAN §4.4) only from `resolved` statuses in the
 * first place, so "an unresolved status never manufactures a finding" is
 * enforced at the point the diff builds a `Finding`, not by this type.
 */
export type ResolvedStatus =
  | { kind: 'resolved'; status: number; confidence: 'high' | 'low' }
  | { kind: 'unknown'; reason: string };

/**
 * A status code a handler can actually produce, plus every source that can
 * produce it.
 */
export interface ProducibleStatus {
  resolved: ResolvedStatus;
  sources: StatusSource[];
}

/**
 * A status code documented on a handler (or its enclosing class) via an
 * `@ApiResponse`-family decorator.
 *
 * `status` is `'default'` for `@ApiDefaultResponse` (PLAN §4.3), which is a
 * wildcard that satisfies nothing specific by default but can be configured
 * to via `AnalysisOptions.treatDefaultAsWildcard`.
 */
export interface DocumentedStatus {
  status: number | 'default';
  /** Decorator name, e.g. `'ApiNotFoundResponse'`. */
  decorator: string;
  /** For reporting / autofix anchoring. */
  node: ts.Node;
  level: 'method' | 'class';
}

/** HTTP methods NestJS route decorators can express (`@All()` included). */
export type HttpMethod =
  'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'OPTIONS' | 'HEAD' | 'ALL' | 'SEARCH';

/**
 * Identifying and locating information for an analyzed handler.
 *
 * `path` is Phase 1's exit criterion ("correct route table ... including
 * class-level path prefixes and `@Get(':id')` params"), so the class prefix
 * and method path are kept as separate fields alongside the joined result
 * rather than leaving `path` to carry all of that ambiguously:
 *
 * - `classPath`: the `@Controller(...)` prefix for the enclosing class
 *   (`''` if none given).
 * - `methodPath`: the route decorator's own path (`''` if none given, e.g.
 *   bare `@Get()`).
 * - `path`: `classPath` and `methodPath` fully joined with a single leading
 *   slash and no trailing slash (e.g. `/users/:id`), the form used in
 *   reports.
 */
export interface HandlerInfo {
  className: string;
  methodName: string;
  httpMethod: HttpMethod;
  classPath: string;
  methodPath: string;
  path: string;
  node: ts.Node;
}

/**
 * A single reportable result of analyzing a handler.
 */
export type Finding =
  | {
      rule: 'undocumented-status';
      status: number;
      handler: HandlerInfo;
      sources: StatusSource[];
      node: ts.Node;
    }
  | {
      /** Opt-in, off by default. */
      rule: 'documented-but-unreachable';
      status: number;
      handler: HandlerInfo;
      node: ts.Node;
    }
  | {
      /** Opt-in, off by default. */
      rule: 'unresolvable-status';
      handler: HandlerInfo;
      node: ts.Node;
      detail: string;
    };

/**
 * Per-run configuration. Grouped separately from the rest of
 * `AnalysisContext` so it's the one piece a CLI flag parser or an ESLint
 * rule's `options` schema maps onto directly.
 */
export interface AnalysisOptions {
  /** Bounded traversal depth into called methods (PLAN §4.1b). */
  maxDepth: number;
  rules: {
    'documented-but-unreachable': boolean;
    'unresolvable-status': boolean;
  };
  /** PLAN §4.3: does `@ApiDefaultResponse` satisfy any/every status? */
  treatDefaultAsWildcard: boolean;
  /** PLAN §6: escape hatch for exception filters that remap status codes. */
  ignoreStatuses: readonly number[];
}

declare const analysisCacheBrand: unique symbol;

/**
 * Opaque memoization cache for the call graph (PLAN §4.1b): conceptually
 * `ts.Symbol -> ProducibleStatus[]`, keyed per `ts.Program`. The brand
 * (a symbol not exported from this module) makes the interface
 * unconstructible from outside — only a future `createAnalysisContext()`
 * (Phase 3) can produce one. That keeps the internal representation free to
 * change without breaking `AnalysisContext`'s public shape.
 */
export interface AnalysisCache {
  readonly [analysisCacheBrand]: true;
}

/**
 * Shared context passed into `analyzeHandler()`. Deliberately carries
 * nothing CLI- or ESLint-specific.
 *
 * `program` is required (not just `checker`): PLAN §4.1b needs to test
 * whether a called method's declaration is "inside the program" (as opposed
 * to `node_modules`), and PLAN §2.1(3) memoizes the call-graph cache keyed on
 * the `ts.Program`. ESLint supplies this for free via
 * `getParserServices(context).program`, so requiring it doesn't cost the
 * ESLint adapter anything — purity (no filesystem/process access inside
 * `core/`) is unaffected either way, since `ts.Program` is just a data
 * structure handed in by the caller.
 */
export interface AnalysisContext {
  program: ts.Program;
  checker: ts.TypeChecker;
  options: AnalysisOptions;
  cache: AnalysisCache;
}
