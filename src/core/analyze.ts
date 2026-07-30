/**
 * `analyzeHandler()` — the public entry point (PLAN §2.1).
 *
 * Phase 2 scope: diff direct throws (§4.1a) against documented statuses
 * (§4.3), honoring `AnalysisOptions.ignoreStatuses`, and emit one
 * `undocumented-status` finding per undocumented status code, carrying every
 * `StatusSource` that can produce it (§4.4). No call graph (§4.1b, Phase 3),
 * no implicit codes (§4.1c, Phase 5), and the opt-in
 * `documented-but-unreachable`/`unresolvable-status` rules are left
 * unimplemented — `AnalysisOptions.rules` exists but is not consulted here
 * yet.
 */

import * as ts from 'typescript';
import type {
  AnalysisCache,
  AnalysisContext,
  AnalysisOptions,
  Finding,
  ProducibleStatus,
  StatusSource,
} from './types.js';
import { getHandlerInfosForMethod } from './handlers.js';
import { collectDirectThrows } from './thrown.js';
import { resolveThrownStatus } from './resolve-status.js';
import { getDocumentedStatuses } from './documented.js';

/**
 * Constructs the opaque `AnalysisCache` (see `types.ts`'s doc comment on
 * `AnalysisCache` — intentionally unconstructible from outside `core/`
 * without this). Phase 2 has no call graph yet, so the cache is inert; it
 * exists now purely so `AnalysisContext` — which requires one — can be
 * constructed at all. Phase 3's call-graph memoization is the first real
 * consumer.
 */
export function createAnalysisCache(): AnalysisCache {
  return {} as unknown as AnalysisCache;
}

/**
 * `ts.Program -> AnalysisCache`, so callers that build a fresh
 * `AnalysisContext` per file (an ESLint rule listening on `MethodDefinition`,
 * one context per lint run) still share a single cache for that `Program` —
 * PLAN §2.1(3)'s "memoize `ts.Symbol -> ProducibleStatus[]` in a `WeakMap`
 * keyed on the Program" exists precisely so re-linting 200 controllers
 * doesn't re-walk `UserService` 200 times. `createAnalysisCache()` above
 * stays available for callers that deliberately want an unshared cache
 * (tests, primarily).
 */
const cachesByProgram = new WeakMap<ts.Program, AnalysisCache>();

function getCacheForProgram(program: ts.Program): AnalysisCache {
  const existing = cachesByProgram.get(program);
  if (existing) return existing;
  const created = createAnalysisCache();
  cachesByProgram.set(program, created);
  return created;
}

/** Convenience constructor for the common case: `program`'s shared cache, checker pulled off `program`. */
export function createAnalysisContext(
  program: ts.Program,
  options: AnalysisOptions,
): AnalysisContext {
  return {
    program,
    checker: program.getTypeChecker(),
    options,
    cache: getCacheForProgram(program),
  };
}

/**
 * Best-effort human-readable label for a thrown expression, for
 * `StatusSource.exception` — used only as a defensive fallback when a
 * `resolveThrownStatus` strategy resolved a status but, unexpectedly,
 * didn't attach an `exception` name (see `ResolvedStatus`'s doc comment;
 * every Phase 2 strategy does attach one, so this path shouldn't normally
 * run).
 */
function describeThrownExpression(expression: ts.Expression): string {
  if (ts.isNewExpression(expression)) {
    const callee = expression.expression;
    if (ts.isIdentifier(callee)) return callee.text;
    if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)) {
      return callee.name.text;
    }
  }
  if (ts.isIdentifier(expression)) return expression.text;
  return expression.getText();
}

/**
 * Direct-throw producible statuses for `methodNode`. Unresolvable throws
 * (`ResolvedStatus.kind === 'unknown'`) are silently dropped here — per PLAN
 * §4.2's invariant, they must never reach the diff.
 */
function collectProducibleStatuses(
  methodNode: ts.MethodDeclaration,
  checker: ts.TypeChecker,
): ProducibleStatus[] {
  const byStatus = new Map<number, StatusSource[]>();

  for (const { node, expression } of collectDirectThrows(methodNode)) {
    const result = resolveThrownStatus(expression, checker);
    if (result.kind !== 'resolved') continue;

    const source: StatusSource = {
      kind: 'throw',
      node,
      exception: result.exception ?? describeThrownExpression(expression),
    };
    const existing = byStatus.get(result.status);
    if (existing) {
      existing.push(source);
    } else {
      byStatus.set(result.status, [source]);
    }
  }

  return [...byStatus.entries()].map(([status, sources]) => ({
    resolved: { kind: 'resolved', status, confidence: 'high' },
    sources,
  }));
}

/**
 * Analyzes a single method declaration: PLAN §2.1's `analyzeHandler(method,
 * ctx)`. Returns `[]` if `methodNode` isn't an HTTP handler on a
 * `@Controller` class (delegates that determination entirely to
 * `getHandlerInfosForMethod`, so discovery rules never drift between the
 * route table and the analyzer), or if it produces no resolvable statuses at
 * all.
 */
export function analyzeHandler(methodNode: ts.MethodDeclaration, ctx: AnalysisContext): Finding[] {
  const handlers = getHandlerInfosForMethod(methodNode, { checker: ctx.checker });
  if (handlers.length === 0) return [];

  const producible = collectProducibleStatuses(methodNode, ctx.checker);
  if (producible.length === 0) return [];

  const documented = getDocumentedStatuses(methodNode, ctx.checker, ctx.options);
  const documentedStatuses = new Set<number>();
  // A `StatusRange` (`'4XX'`) documents every status whose first digit
  // matches — tracked by that leading digit (`'4'`) rather than by
  // enumerating every status in the range.
  const documentedRangeDigits = new Set<string>();
  let hasWildcard = false;
  for (const d of documented) {
    if (d.status === 'default') {
      hasWildcard = true;
    } else if (typeof d.status === 'number') {
      documentedStatuses.add(d.status);
    } else {
      documentedRangeDigits.add(d.status.charAt(0));
    }
  }
  // A wildcard (`@ApiDefaultResponse` with `treatDefaultAsWildcard: true`,
  // or an unresolvable `@ApiResponse` argument — see `documented.ts`'s S2
  // doc comment) suppresses every status for every handler this method
  // yields — hoisted out of the loop below rather than checked per
  // status/per handler, since its value can't change once computed.
  if (hasWildcard) return [];

  const ignoreStatuses = new Set(ctx.options.ignoreStatuses);
  const findings: Finding[] = [];

  for (const handler of handlers) {
    for (const { resolved, sources } of producible) {
      if (resolved.kind !== 'resolved') continue; // always true by construction, narrows the type
      const { status } = resolved;
      if (documentedStatuses.has(status)) continue;
      if (documentedRangeDigits.has(String(status).charAt(0))) continue;
      if (ignoreStatuses.has(status)) continue;
      findings.push({ rule: 'undocumented-status', status, handler, sources, node: methodNode });
    }
  }

  return findings;
}
