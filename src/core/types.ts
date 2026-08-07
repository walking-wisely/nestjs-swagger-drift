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
      reason: 'validation-pipe' | 'guard' | 'success' | 'parse-pipe';
      /**
       * Optional extra context a report can show alongside `reason` (Phase 5,
       * PLAN §4.1c). Added as an optional field rather than widening
       * `'implicit'` into per-reason variants (which would ripple through
       * every existing `source.kind === 'implicit'` switch in `analyze.ts`/
       * `report/*.ts`) or bolting on a `via`-shaped call path (which
       * `service-throw` needs for a *traversal*, whereas a `'guard'` source's
       * "path" is really just "which guard, and — if it wasn't the guard's
       * own `canActivate` but something it called — the one-line hop chain
       * into it," better expressed as text than as a structural field no
       * other implicit reason has any use for). Populated by:
       *
       * - `'success'`: never set — the reason alone is already the whole
       *   story (`describeSuccessSource` in `success.ts` has nothing to add).
       * - `'validation-pipe'`: the DTO class name (e.g. `'CreateUserDto'`),
       *   so the report can say *which* parameter's decorators triggered it.
       * - `'guard'`: the guard class name, plus (when the throw was found
       *   more than one call hop into the guard) the hop chain, e.g.
       *   `'AuthGuard.canActivate'` or `'AuthGuard.canActivate → TokenService.verify'`.
       * - `'parse-pipe'` (issue #17): the built-in `Parse*Pipe` class name(s)
       *   found (e.g. `'ParseIntPipe'`, or a comma-joined list when more than
       *   one parameter qualifies), mirroring `'validation-pipe'`'s shape.
       */
      detail?: string;
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
 *
 * `exception` (Phase 2 review, S4) carries the resolved exception *class*
 * name (`'NotFoundException'`), when `resolve-status.ts`'s strategy that
 * produced this result knows one — which is every strategy that resolves
 * something, so in practice this is always set on a `'resolved'` result.
 * Exists so callers (`analyze.ts`) don't fall back to describing the thrown
 * *expression* (which, for a rethrown identifier like `throw notFound`,
 * would be the variable name `'notFound'`, not the exception class) when a
 * proper class name is available.
 */
export type ResolvedStatus =
  | { kind: 'resolved'; status: number; confidence: 'high' | 'low'; exception?: string }
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
 * The `NXX` range-wildcard forms `@nestjs/swagger`'s real
 * `ApiResponseOptions.status` type allows (`'1XX' | '2XX' | ... | '5XX'`),
 * documenting "any status in this range" rather than one code. (Phase 2
 * review S2.)
 */
export type StatusRange = '1XX' | '2XX' | '3XX' | '4XX' | '5XX';

/**
 * A status code documented on a handler (or its enclosing class) via an
 * `@ApiResponse`-family decorator.
 *
 * `status` is `'default'` for `@ApiDefaultResponse` (PLAN §4.3), which is a
 * wildcard that satisfies nothing specific by default but can be configured
 * to via `AnalysisOptions.treatDefaultAsWildcard` — and also for a generic
 * `@ApiResponse(...)` call whose argument object contains a spread and no
 * statically-resolvable `status` (Phase 2 review S2): the argument's real
 * status is genuinely unknown at analysis time, and unlike an unresolvable
 * *thrown* status (which must be dropped — PLAN §4.2), an unresolvable
 * *documented* status is FP-safer treated as "might document anything" than
 * as "documents nothing", so it's folded into the same wildcard value
 * `analyzeHandler` already knows how to treat as satisfying everything.
 * A `StatusRange` (`'4XX'`) documents every status in that range.
 */
export interface DocumentedStatus {
  status: number | 'default' | StatusRange;
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
 * - `unresolvedPath`: `true` if either `classPath` or `methodPath` could not
 *   be fully resolved to a literal string at analysis time (e.g. a template
 *   literal with an interpolation, a `const` reference the checker couldn't
 *   pin to a literal type, string concatenation, or an array path with a
 *   non-literal element). When `true`, `path` is a best-effort value, not a
 *   guarantee — callers (the CLI, future rules) must not present it as fact.
 *   This exists because a silently-wrong `path` is worse than an honestly
 *   incomplete one: every later-phase finding is reported through `path`.
 */
export interface HandlerInfo {
  className: string;
  methodName: string;
  httpMethod: HttpMethod;
  classPath: string;
  methodPath: string;
  path: string;
  unresolvedPath: boolean;
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
      /**
       * What couldn't be resolved: an unresolvable THROWN status (the
       * original shape) or — issue #15 — an unresolvable `@HttpCode(...)`
       * SUCCESS-status argument. Both share the `unresolvable-status` rule
       * (same "couldn't tell, but say so" purpose), but they are not the
       * same kind of finding — a reporter that always says "has a throw" is
       * simply wrong for the latter. Required (not optional) so every
       * reporter is forced to handle both rather than silently defaulting to
       * one. Named `unresolvableKind`, not `kind` (adversarial review): a
       * `StatusSource` ALSO has its own `kind` field
       * (`"throw" | "service-throw" | "implicit"`) with a different value
       * set and a different meaning, and `--reporter json` surfaces both on
       * the same `unresolvable-status` finding (this field at the top level,
       * `sources[].kind` — always empty for this rule, but still part of the
       * shared `Finding` shape) — reusing the same key name at two nesting
       * levels with different meanings was confusing enough to call out.
       */
      unresolvableKind: 'throw' | 'success';
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
  /**
   * Bounded traversal depth into called methods (PLAN §4.1b), counted in
   * CROSS-CLASS hops — a method calling a private helper on its OWN class
   * doesn't consume this budget (`call-graph.ts`'s "same-class hops are
   * free"), only a call that crosses into a different class does.
   */
  maxDepth: number;
  rules: {
    'documented-but-unreachable': boolean;
    'unresolvable-status': boolean;
  };
  /** PLAN §4.3: does `@ApiDefaultResponse` satisfy any/every status? */
  treatDefaultAsWildcard: boolean;
  /** PLAN §6: escape hatch for exception filters that remap status codes. */
  ignoreStatuses: readonly number[];
  /**
   * Audit mode (PLAN §5 Phase 4 review, finding S6): when `true`,
   * `swagger-drift-disable-next-line` directives are ignored entirely, so
   * every finding a suppression would otherwise hide surfaces normally.
   * Optional and defaults to `false` (suppressions apply) so existing
   * `AnalysisOptions` literals — tests, the CLI, a future ESLint adapter —
   * don't need to know this exists unless they want it.
   */
  ignoreSuppressions?: boolean;

  /**
   * PLAN §4.1c / §9's open decision, resolved "yes": check that a handler
   * documents *some* 2xx success response — `200` for most HTTP methods,
   * `201` for `@Post()`, or whatever `@HttpCode(n)` overrides it to
   * (`success.ts`). The one implicit-codes check that's on by default:
   * unlike `checkValidationPipe`/`checkGuards` below, there is no heuristic
   * "is this actually wired up" guesswork involved — every NestJS handler
   * that returns normally produces *some* status code, so documenting none
   * at all is unconditionally a gap, not a maybe.
   *
   * Optional, defaulting to `true` at the point of use (`analyze.ts`), not
   * given a hard default value here, so existing `AnalysisOptions` literals
   * across the test suite (written before this field existed) keep
   * compiling and keep testing exactly what they tested before — an
   * explicit `false` is how a caller that wants the pre-Phase-5 behavior
   * asks for it.
   */
  checkSuccessResponse?: boolean;

  /**
   * PLAN §4.1c: treat `400` as producible when a handler parameter is typed
   * as a class carrying `class-validator` decorators (`@IsString()`,
   * `@IsNotEmpty()`, ...) AND is itself decorated with `@Body()`/`@Param()`/
   * `@Query()` (`validation-pipe.ts`). Opt-in, defaulting to `false` at the
   * point of use: this tool cannot see whether `ValidationPipe` is actually
   * registered (globally, per-route, or not at all) — a DTO's decorators
   * alone don't prove NestJS will act on them — so per PLAN §4.2's "silence
   * over noise" bias this stays off until a caller explicitly opts in.
   */
  checkValidationPipe?: boolean;

  /**
   * PLAN §4.1c: resolve `@UseGuards(...)` classes and recurse into their
   * `canActivate` with the same bounded call-graph machinery `call-graph.ts`
   * already uses for services, collecting `401`/`403`-shaped throws
   * (`guards.ts`). Opt-in, defaulting to `false` at the point of use, for the
   * same reason as `checkValidationPipe`: a `@UseGuards` reference proves a
   * guard is *attached*, not that its `canActivate` genuinely throws the way
   * this analysis assumes (a guard could return `false` without throwing,
   * for instance, which NestJS turns into its own default `403` this tool
   * has no way to attribute to a specific line) — real, if smaller, guesswork
   * versus the unconditional `checkSuccessResponse` case above.
   */
  checkGuards?: boolean;

  /**
   * PLAN §4.1c-adjacent (issue #17): treat `400` (or, when a pipe's
   * `errorHttpStatusCode` option is statically resolvable, that overridden
   * status instead) as producible when a handler parameter decorated with
   * `@Body()`/`@Param()`/`@Query()`/`@Headers()`/`@UploadedFile()`/
   * `@UploadedFiles()` also carries one of NestJS's built-in transformation
   * pipes (`ParseIntPipe`, `ParseUUIDPipe`, `ParseBoolPipe`, `ParseEnumPipe`,
   * `ParseFloatPipe`, `ParseArrayPipe`, `ParseFilePipe`, `ParseDatePipe` —
   * `parse-pipes.ts`). The decorator set is wider than
   * `checkValidationPipe`'s Body/Param/Query-only scope — see
   * `parse-pipes.ts`'s module doc for why — and every distinct pipe named on
   * a single decorator call is collected, not just the first one found.
   * Opt-in, defaulting to `false` at the point of use, for the same reason as
   * `checkValidationPipe`: this tool cannot see whether the pipe genuinely
   * runs at request time, only that the decorator call names one.
   */
  checkParsePipes?: boolean;
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
