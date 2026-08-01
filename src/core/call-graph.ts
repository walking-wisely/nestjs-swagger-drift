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

/** A function/method declaration with a real, walkable `Block` body. */
type FunctionDeclWithBody = ts.FunctionLikeDeclarationBase & { body: ts.Block };

/** One resolved status reached through the call graph, ready to fold into `analyze.ts`'s producible-status map. */
export interface CallGraphFinding {
  resolved: Extract<ResolvedStatus, { kind: 'resolved' }>;
  source: Extract<StatusSource, { kind: 'service-throw' }>;
}

interface ResolvedCallTarget {
  callNode: ts.CallExpression;
  decl: FunctionDeclWithBody;
  symbol: ts.Symbol;
}

interface CacheEntry {
  ownThrows: Array<{ node: ts.Node; resolved: Extract<ResolvedStatus, { kind: 'resolved' }> }>;
  calls: ResolvedCallTarget[];
}

function isFunctionLikeWithBody(decl: ts.Declaration): decl is FunctionDeclWithBody {
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
  for (const { node, expression } of collectDirectThrows(decl)) {
    const resolved = resolveThrownStatus(expression, ctx.checker);
    if (resolved.kind === 'resolved') ownThrows.push({ node, resolved });
  }

  const calls: ResolvedCallTarget[] = [];
  for (const callNode of collectProducibleCallSites(decl)) {
    const target = resolveCallTarget(callNode, ctx.checker, ctx.program);
    if (!target) continue;
    calls.push({ callNode, decl: target.decl, symbol: target.symbol });
  }

  return { ownThrows, calls };
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
  callNode: ts.CallExpression,
  ctx: AnalysisContext,
  remainingDepth: number,
  pathSoFar: ReadonlyArray<{ name: string; node: ts.Node }>,
  visited: Set<ts.Symbol>,
  cacheMap: Map<ts.Symbol, CacheEntry>,
  results: CallGraphFinding[],
): void {
  if (remainingDepth <= 0) return;
  if (visited.has(target.symbol)) return; // cycle guard: mutually recursive services terminate here

  const hop = { name: labelForDeclaration(target.decl), node: callNode as ts.Node };
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

  visited.add(target.symbol);
  for (const nextCall of entry.calls) {
    expand(
      { decl: nextCall.decl, symbol: nextCall.symbol },
      nextCall.callNode,
      ctx,
      remainingDepth - 1,
      hopPath,
      visited,
      cacheMap,
      results,
    );
  }
  visited.delete(target.symbol);
}

/**
 * Collects every status reachable by traversing calls made directly in
 * `handlerBody` (a controller handler's own body, or — recursively — any
 * function-like body reached from it), up to `ctx.options.maxDepth` hops.
 * Does NOT include `handlerBody`'s own direct throws — those are
 * `analyze.ts`'s `kind: 'throw'` sources, collected separately; this only
 * ever produces `kind: 'service-throw'` sources, one hop or more away.
 */
export function collectCallGraphStatuses(
  handlerBody: ts.FunctionLikeDeclarationBase,
  ctx: AnalysisContext,
): CallGraphFinding[] {
  const results: CallGraphFinding[] = [];
  if (ctx.options.maxDepth <= 0) return results;

  const cacheMap = getCallGraphCache(ctx.cache);
  const visited = new Set<ts.Symbol>();

  for (const callNode of collectProducibleCallSites(handlerBody)) {
    const target = resolveCallTarget(callNode, ctx.checker, ctx.program);
    if (!target) continue;
    expand(target, callNode, ctx, ctx.options.maxDepth, [], visited, cacheMap, results);
  }

  return results;
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
