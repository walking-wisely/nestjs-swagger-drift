/**
 * Bounded call-graph traversal (PLAN §4.1b): for each `CallExpression` in a
 * handler body (or, recursively, in a called method's body) whose callee
 * resolves unambiguously to a method/function declaration *inside the
 * program* — not `node_modules`, not an interface/abstract signature with no
 * body — recurse into that declaration and collect its own throws, resolved
 * through `resolve-status.ts`'s existing ladder. This is Phase 3's single
 * biggest false-positive risk (PLAN task brief): every hop multiplies the
 * chance of attributing a status to an endpoint that cannot actually produce
 * it, so every ambiguous shape below resolves to "contribute nothing," never
 * a guess.
 *
 * ## Reuse, not duplication
 *
 * Which `CallExpression`s even count as "reachable" (not inside a caught
 * `try` block, not trivially unreachable) is delegated entirely to
 * `thrown.ts`'s `walkProducibleNodes` — the exact same walk `throw`s use.
 * `try { await this.svc.find() } catch { return null }` marks the call site
 * non-producible the same way it marks a direct `throw` non-producible, so
 * `this.svc.find()`'s throws are never traversed into. This is the
 * regression PLAN calls out explicitly ("reproduces the worst false
 * positive found in Phase 2, transitively") if gotten wrong.
 *
 * ## Callee resolution: unambiguous or nothing
 *
 * `resolveCallTarget` requires the callee expression's own symbol to have
 * *exactly one* declaration with a real body:
 *
 * - Zero such declarations covers interface-typed and abstract-typed
 *   dependencies (`constructor(private readonly svc: IUserService)`) —
 *   the checker resolves the property access against the STATIC
 *   (interface/abstract) type, whose method has no body, so nothing is
 *   traversed. NestJS DI does not change this: the static type is what the
 *   checker sees, not the concrete class actually injected at runtime.
 * - More than one such declaration covers a union-typed callee (TypeScript
 *   synthesizes a single transient symbol for a property access on a union,
 *   whose declarations span every union member that has the property) and,
 *   defensively, any other case where the same name means two different
 *   implementations. Both are "ambiguous" per the task brief and resolve to
 *   nothing rather than an arbitrary pick.
 * - A `new X(...)` expression is a `NewExpression`, not a `CallExpression`,
 *   so constructors are never traversed by this module at all — out of
 *   scope, not merely excluded by the ambiguity check.
 * - A bare method reference passed as a callback (`items.map(this.validate)`)
 *   is a `PropertyAccessExpression`, not itself a `CallExpression`, so it's
 *   never collected as a call site in the first place. The callback body
 *   itself (`items.map(item => this.validate(item))`) is skipped because
 *   `walkProducibleNodes` never descends into a nested function-like body —
 *   same reachability rule a `throw` inside that callback is already subject
 *   to (`thrown.ts`'s module doc).
 * - A resolved declaration whose source file is outside the program
 *   (`node_modules`, the default lib) is dropped via `ts.Program`'s own
 *   `isSourceFileFromExternalLibrary`/`isSourceFileDefaultLibrary` — no
 *   `node:path` involved, keeping this module Node-free per PLAN §3.
 *
 * ## Depth and cycles
 *
 * `AnalysisOptions.maxDepth` (default 2) bounds how many call hops beyond
 * the handler are traversed — `maxDepth: 2` reaches a service (hop 1) and
 * whatever the service calls (hop 2), matching PLAN §4.1b's "service, then
 * repository" framing. A `visited` set of `ts.Symbol`s scoped to the current
 * DFS path (added on entry, removed on exit) guards against mutually
 * recursive methods, while still allowing a genuine diamond (`A` and `B` both
 * calling `D`) to be traversed from both paths.
 *
 * ## Same-class hops are free (adversarial-testing finding, post-Phase-6)
 *
 * A hop only consumes depth budget when it crosses into a DIFFERENT class
 * than the one being expanded. A service method that calls a private helper
 * on `this`, which in turn calls a repository, is two hops by call-site
 * count but only ONE genuine dependency crossing (service → repository) —
 * extracting a private helper for readability is exactly the kind of
 * refactor that must not change what this tool can see. Verified against a
 * real false positive: a throw reached only through such a private
 * same-class helper was reported as `documented-but-unreachable` at the
 * default `maxDepth: 2` purely because the helper hop ate the budget the
 * repository call needed — not because the throw was actually unreachable.
 * `getOwnerClass` below identifies "same class" structurally (the declaring
 * class node, not name-based, so two different classes that happen to share
 * a method name are never conflated); a declaration with no owning class (a
 * free function) never counts as "same class" as anything, so it always
 * costs a hop, matching prior behavior exactly. This is a strict widening —
 * free-function and cross-class chains still cost one hop per hop,
 * unchanged — so it cannot make anything LESS reachable than before, only
 * more.
 *
 * ## Memoization
 *
 * The expensive part of visiting a declaration — walking its body for
 * throws and resolving each of its own call sites — is memoized per
 * `ts.Symbol` in a cache keyed off `AnalysisContext.cache`'s identity (see
 * `types.ts`'s `AnalysisCache` doc: this is Phase 3's first real consumer).
 * Deliberately depth-independent: a declaration's own throws and its own
 * call sites are structural facts that never change with how much depth
 * budget remains at the call site that reached them, so caching by symbol
 * alone (not `(symbol, remainingDepth)`) is both simpler and correct — the
 * depth bound is enforced fresh on every traversal by the recursion itself,
 * only the expensive per-declaration computation is reused.
 */

import * as ts from 'typescript';
import type { AnalysisContext, AnalysisCache, ResolvedStatus, StatusSource } from './types.js';
import { collectDirectThrows, walkProducibleNodes } from './thrown.js';
import { resolveThrownStatus } from './resolve-status.js';

/**
 * A function/method declaration with a real, walkable `Block` body. Exported
 * (Phase 5) so `guards.ts` can share the exact predicate/type this module
 * uses to decide "is this a traversable declaration at all" when resolving a
 * `@UseGuards(...)` class's `canActivate` method, rather than redefining it.
 */
export type FunctionDeclWithBody = ts.FunctionLikeDeclarationBase & { body: ts.Block };

/** One resolved status reached through the call graph, ready to fold into `analyze.ts`'s producible-status map. */
export interface CallGraphFinding {
  resolved: Extract<ResolvedStatus, { kind: 'resolved' }>;
  source: Extract<StatusSource, { kind: 'service-throw' }>;
}

/**
 * One throw reached through the call graph whose status `resolve-status.ts`
 * could not resolve — surfaced (Phase 5 review) for `analyze.ts`'s opt-in
 * `unresolvable-status` rule, mirroring `CallGraphFinding`'s shape: `via` is
 * the same per-hop call path `StatusSource`'s `service-throw` variant
 * carries, so a report can show where in the call graph the unresolvable
 * throw actually lives, not just that one exists somewhere.
 */
export interface CallGraphUnresolvedThrow {
  node: ts.Node;
  reason: string;
  via: Array<{ name: string; node: ts.Node }>;
}

interface ResolvedCallTarget {
  callNode: ts.CallExpression;
  decl: FunctionDeclWithBody;
  symbol: ts.Symbol;
}

interface CacheEntry {
  ownThrows: Array<{ node: ts.Node; resolved: Extract<ResolvedStatus, { kind: 'resolved' }> }>;
  /**
   * Own throws `resolve-status.ts` could NOT resolve (Phase 5 review, finding
   * #6): previously dropped here entirely — the same "silently dropped"
   * posture `analyze.ts` used to have for a handler's own direct unresolved
   * throws before `unresolvable-status` existed. Computed alongside
   * `ownThrows` in the same walk over `collectDirectThrows(decl)`, so keeping
   * this costs nothing beyond storing a result the traversal already
   * produces — there was no real memory/complexity case for dropping it (see
   * `analyze.ts`'s module doc for the honest version of that reasoning).
   */
  ownUnresolvedThrows: Array<{ node: ts.Node; reason: string }>;
  calls: ResolvedCallTarget[];
}

/** Exported alongside `FunctionDeclWithBody` — see that type's doc comment. */
export function isFunctionLikeWithBody(decl: ts.Declaration): decl is FunctionDeclWithBody {
  return (
    (ts.isMethodDeclaration(decl) ||
      ts.isFunctionDeclaration(decl) ||
      ts.isFunctionExpression(decl) ||
      ts.isArrowFunction(decl)) &&
    decl.body !== undefined &&
    ts.isBlock(decl.body)
  );
}

/**
 * Human-readable hop label, e.g. `'UsersService.create'` for a method inside
 * a named class, or `'validateInput'` for a free function / exported const
 * helper. Falls back to `'<anonymous>'` only for shapes that shouldn't
 * normally reach here (an anonymous default-exported function expression).
 */
function labelForDeclaration(decl: FunctionDeclWithBody): string {
  if (ts.isMethodDeclaration(decl) && ts.isIdentifier(decl.name)) {
    const owner = decl.parent;
    if (ts.isClassLike(owner) && owner.name) return `${owner.name.text}.${decl.name.text}`;
    return decl.name.text;
  }
  if (ts.isFunctionDeclaration(decl) && decl.name) return decl.name.text;
  const parent = decl.parent;
  if (ts.isPropertyDeclaration(parent) && ts.isIdentifier(parent.name)) {
    const owner = parent.parent;
    if (ts.isClassLike(owner) && owner.name) return `${owner.name.text}.${parent.name.text}`;
    return parent.name.text;
  }
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  return '<anonymous>';
}

/**
 * The class that lexically declares `decl`, or `undefined` for a free
 * function/exported const helper — see module doc's "same-class hops are
 * free". Mirrors `labelForDeclaration`'s own owner-finding logic (a method's
 * parent, or an arrow/function-expression class property's parent) so the
 * two never disagree about what "belongs to this class" means; kept as a
 * separate function rather than folded into `labelForDeclaration` because
 * callers need the class NODE (for identity comparison), not its name.
 */
function getOwnerClass(decl: FunctionDeclWithBody): ts.ClassLikeDeclaration | undefined {
  if (ts.isMethodDeclaration(decl)) {
    const owner = decl.parent;
    return ts.isClassLike(owner) ? owner : undefined;
  }
  const parent = decl.parent;
  if (ts.isPropertyDeclaration(parent)) {
    const owner = parent.parent;
    return ts.isClassLike(owner) ? owner : undefined;
  }
  return undefined;
}

/**
 * Every `CallExpression` in `fn`'s body reachable under the identical
 * try/catch-suppression and trivial-unreachability rules `collectDirectThrows`
 * applies to `throw`s (see module doc's "reuse, not duplication").
 */
function collectProducibleCallSites(fn: ts.FunctionLikeDeclarationBase): ts.CallExpression[] {
  const results: ts.CallExpression[] = [];
  walkProducibleNodes(fn, (node, producible) => {
    if (producible && ts.isCallExpression(node)) results.push(node);
  });
  return results;
}

/**
 * Resolves `call`'s callee to a single, unambiguous, in-program declaration
 * with a body — see module doc's "callee resolution: unambiguous or
 * nothing" for the full reasoning behind each `undefined` return.
 */
function resolveCallTarget(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
  program: ts.Program,
): { decl: FunctionDeclWithBody; symbol: ts.Symbol } | undefined {
  let calleeSymbol: ts.Symbol | undefined;
  try {
    calleeSymbol = checker.getSymbolAtLocation(call.expression);
  } catch {
    calleeSymbol = undefined;
  }
  if (!calleeSymbol) return undefined;

  const bodies = new Set<FunctionDeclWithBody>(
    (calleeSymbol.getDeclarations() ?? []).filter(isFunctionLikeWithBody),
  );
  // 0: interface/abstract-typed dependency, ambient declaration, or a
  // getter/setter (never callable via `()` in the first place, but excluded
  // here too as defense in depth). >1: union-typed callee or a genuinely
  // ambiguous same-named symbol. Either way: contribute nothing.
  if (bodies.size !== 1) return undefined;
  let decl: FunctionDeclWithBody | undefined;
  for (const d of bodies) decl = d;
  if (!decl) return undefined; // unreachable given size === 1, satisfies strict narrowing

  const sourceFile = decl.getSourceFile();
  if (program.isSourceFileFromExternalLibrary(sourceFile)) return undefined;
  if (program.isSourceFileDefaultLibrary(sourceFile)) return undefined;

  return { decl, symbol: calleeSymbol };
}

function computeCacheEntry(decl: FunctionDeclWithBody, ctx: AnalysisContext): CacheEntry {
  computeCount++; // testing-only instrumentation, see `__getCallGraphMemoStatsForTesting`

  const ownThrows: CacheEntry['ownThrows'] = [];
  const ownUnresolvedThrows: CacheEntry['ownUnresolvedThrows'] = [];
  for (const { node, expression } of collectDirectThrows(decl)) {
    const resolved = resolveThrownStatus(expression, ctx.checker);
    if (resolved.kind === 'resolved') {
      ownThrows.push({ node, resolved });
    } else {
      ownUnresolvedThrows.push({ node, reason: resolved.reason });
    }
  }

  const calls: ResolvedCallTarget[] = [];
  for (const callNode of collectProducibleCallSites(decl)) {
    const target = resolveCallTarget(callNode, ctx.checker, ctx.program);
    if (!target) continue;
    calls.push({ callNode, decl: target.decl, symbol: target.symbol });
  }

  return { ownThrows, ownUnresolvedThrows, calls };
}

const callGraphCaches = new WeakMap<AnalysisCache, Map<ts.Symbol, CacheEntry>>();

function getCallGraphCache(cache: AnalysisCache): Map<ts.Symbol, CacheEntry> {
  let map = callGraphCaches.get(cache);
  if (!map) {
    map = new Map();
    callGraphCaches.set(cache, map);
  }
  return map;
}

function getOrComputeCacheEntry(
  cacheMap: Map<ts.Symbol, CacheEntry>,
  target: { decl: FunctionDeclWithBody; symbol: ts.Symbol },
  ctx: AnalysisContext,
): CacheEntry {
  const existing = cacheMap.get(target.symbol);
  if (existing) return existing;
  const computed = computeCacheEntry(target.decl, ctx);
  cacheMap.set(target.symbol, computed);
  return computed;
}

function expand(
  target: { decl: FunctionDeclWithBody; symbol: ts.Symbol },
  callNode: ts.Node,
  ctx: AnalysisContext,
  remainingDepth: number,
  pathSoFar: ReadonlyArray<{ name: string; node: ts.Node }>,
  visited: Set<ts.Symbol>,
  cacheMap: Map<ts.Symbol, CacheEntry>,
  results: CallGraphFinding[],
  unresolvedResults: CallGraphUnresolvedThrow[],
): void {
  if (remainingDepth <= 0) return;
  if (visited.has(target.symbol)) return; // cycle guard: mutually recursive services terminate here

  const hop = { name: labelForDeclaration(target.decl), node: callNode };
  const hopPath = [...pathSoFar, hop];

  const entry = getOrComputeCacheEntry(cacheMap, target, ctx);

  for (const { node, resolved } of entry.ownThrows) {
    results.push({
      resolved,
      source: {
        kind: 'service-throw',
        node,
        exception: resolved.exception ?? 'UnknownException',
        via: hopPath,
      },
    });
  }
  for (const { node, reason } of entry.ownUnresolvedThrows) {
    unresolvedResults.push({ node, reason, via: hopPath });
  }

  visited.add(target.symbol);
  const callerOwnerClass = getOwnerClass(target.decl);
  for (const nextCall of entry.calls) {
    // Same-class hop: doesn't consume depth budget — see module doc's
    // "same-class hops are free". `callerOwnerClass` is `undefined` for a
    // free function, which never equals `getOwnerClass(nextCall.decl)`
    // (also possibly `undefined`) by this check, so a free-function hop
    // always costs depth exactly like before this change.
    const sameClass =
      callerOwnerClass !== undefined && getOwnerClass(nextCall.decl) === callerOwnerClass;
    expand(
      { decl: nextCall.decl, symbol: nextCall.symbol },
      nextCall.callNode,
      ctx,
      sameClass ? remainingDepth : remainingDepth - 1,
      hopPath,
      visited,
      cacheMap,
      results,
      unresolvedResults,
    );
  }
  visited.delete(target.symbol);
}

/** The combined result of a call-graph traversal: resolved statuses, plus (Phase 5 review) unresolved ones. */
export interface CallGraphResult {
  findings: CallGraphFinding[];
  unresolvedThrows: CallGraphUnresolvedThrow[];
}

/**
 * Collects every status reachable by traversing calls made directly in
 * `handlerBody` (a controller handler's own body, or — recursively — any
 * function-like body reached from it), up to `ctx.options.maxDepth` hops.
 * Does NOT include `handlerBody`'s own direct throws — those are
 * `analyze.ts`'s `kind: 'throw'` sources, collected separately; `findings`
 * only ever carries `kind: 'service-throw'` sources, one hop or more away.
 * `unresolvedThrows` is the call-graph counterpart of `analyze.ts`'s own
 * direct-throw `unresolvedThrows` list, for the opt-in `unresolvable-status`
 * rule (Phase 5 review, finding #6 — previously dropped here entirely).
 */
export function collectCallGraphStatuses(
  handlerBody: ts.FunctionLikeDeclarationBase,
  ctx: AnalysisContext,
): CallGraphResult {
  const results: CallGraphFinding[] = [];
  const unresolvedResults: CallGraphUnresolvedThrow[] = [];
  if (ctx.options.maxDepth <= 0) return { findings: results, unresolvedThrows: unresolvedResults };

  const cacheMap = getCallGraphCache(ctx.cache);
  const visited = new Set<ts.Symbol>();

  for (const callNode of collectProducibleCallSites(handlerBody)) {
    const target = resolveCallTarget(callNode, ctx.checker, ctx.program);
    if (!target) continue;
    expand(
      target,
      callNode,
      ctx,
      ctx.options.maxDepth,
      [],
      visited,
      cacheMap,
      results,
      unresolvedResults,
    );
  }

  return { findings: results, unresolvedThrows: unresolvedResults };
}

/**
 * PLAN §4.1c / Phase 5: `guards.ts`'s entry point into this module's
 * traversal machinery, reused rather than duplicated (per the task brief's
 * explicit "reuse the SAME call-graph machinery already used for services").
 * Where `collectCallGraphStatuses` starts ONE hop below `handlerBody` (its
 * own throws are the caller's separate `kind: 'throw'` sources), this starts
 * `expand` directly ON `target` — a resolved `@UseGuards(...)` class's
 * `canActivate` method is itself the traversal root, not something reached
 * by a `CallExpression` inside a body this function walks. `entryNode` is
 * used only as the first hop's location marker (`StatusSource`'s `via`/
 * `node` never actually reads a hop's `node` for anything but that): passing
 * the `@UseGuards(...)` argument expression that named the guard class
 * anchors that first hop at the point in the controller where the guard was
 * attached, which reads better than the guard class declaration itself when
 * a report ever surfaces it.
 */
export function collectThrowsFromDeclaration(
  target: { decl: FunctionDeclWithBody; symbol: ts.Symbol },
  entryNode: ts.Node,
  ctx: AnalysisContext,
  maxDepth: number,
): CallGraphResult {
  const results: CallGraphFinding[] = [];
  const unresolvedResults: CallGraphUnresolvedThrow[] = [];
  if (maxDepth <= 0) return { findings: results, unresolvedThrows: unresolvedResults };

  const cacheMap = getCallGraphCache(ctx.cache);
  const visited = new Set<ts.Symbol>();
  expand(target, entryNode, ctx, maxDepth, [], visited, cacheMap, results, unresolvedResults);
  return { findings: results, unresolvedThrows: unresolvedResults };
}

// --- Testing-only instrumentation -----------------------------------------
//
// Exposed so unit tests can assert the memoization cache is actually being
// hit (PLAN task brief: "assert the cache is actually hit"), rather than
// only asserting on output shape, which would pass even with memoization
// silently broken. Not exported from `core/index.ts`'s public barrel.

let computeCount = 0;

/** Resets the module-level "how many times was a declaration's body actually walked" counter. */
export function __resetCallGraphMemoStatsForTesting(): void {
  computeCount = 0;
}

/** How many times `computeCacheEntry` has actually run (i.e. cache misses) since the last reset. */
export function __getCallGraphMemoStatsForTesting(): { computed: number } {
  return { computed: computeCount };
}
