/**
 * The implicit `401`/`403` a handler can produce via `@UseGuards(...)` (PLAN
 * §4.1c, opt-in — see `types.ts`'s doc comment on
 * `AnalysisOptions.checkGuards` for why). Resolves each guard class named on
 * a method- or class-level `@UseGuards(...)` decorator, finds its
 * `canActivate` method, and recurses into it with `call-graph.ts`'s bounded
 * traversal (`collectThrowsFromDeclaration`) — the exact same machinery
 * already used for service calls, per the task brief's explicit "reuse, not
 * duplicate" instruction. A guard's own throws (typically
 * `UnauthorizedException`/`ForbiddenException`, but whatever it actually
 * throws is resolved the normal way) surface as `kind: 'implicit', reason:
 * 'guard'` sources, `detail` carrying the hop label(s)
 * `call-graph.ts`'s traversal already produces (e.g. `'AuthGuard.canActivate'`,
 * or `'AuthGuard.canActivate → TokenService.verify'` when the throw is
 * further down the guard's own call graph) — see `StatusSource`'s doc
 * comment in `types.ts` for why this is a `detail` string rather than a
 * structural `via` field.
 *
 * Both a class-level `@UseGuards` (applies to every handler on the
 * controller) and a method-level one (applies to that handler only,
 * additively — NestJS runs both) are read; PLAN's own `@UseGuards` mention
 * doesn't distinguish the two, and NestJS itself doesn't either.
 *
 * Deliberately narrow resolution, silence-over-noise same as everywhere
 * else: only a `@UseGuards(SomeGuard)` argument that is a plain class
 * reference (an `Identifier`, or `new SomeGuard(...)` — a guard instantiated
 * inline, whose class is still statically known) is followed. A factory call
 * (`@UseGuards(AuthGuardFactory())`), a variable holding an unresolved
 * value, or a spread contributes nothing.
 */

import * as ts from 'typescript';
import type { AnalysisContext, ResolvedStatus } from './types.js';
import { getDecoratorInfos } from './decorators.js';
import { getBaseClassDeclaration, resolveClassDeclaration } from './heritage.js';
import {
  collectThrowsFromDeclaration,
  isFunctionLikeWithBody,
  type FunctionDeclWithBody,
} from './call-graph.js';

const NEST_COMMON_MODULE = '@nestjs/common';
const MAX_GUARD_HERITAGE_DEPTH = 5;

export interface GuardFinding {
  resolved: Extract<ResolvedStatus, { kind: 'resolved' }>;
  // NOT `Extract<StatusSource, { kind: 'implicit'; reason: 'guard' }>`: since
  // `StatusSource`'s implicit variant's `reason` is the WIDER union
  // `'validation-pipe' | 'guard' | 'success'`, that variant does not
  // structurally extend `{ reason: 'guard' }` as a whole, so `Extract`
  // silently resolves to `never` instead of narrowing — this spells out the
  // exact shape this module actually produces instead.
  source: { kind: 'implicit'; reason: 'guard'; node: ts.Node; detail?: string };
}

function getDecoratorCallArguments(decorator: ts.Decorator): readonly ts.Expression[] {
  const expr = decorator.expression;
  return ts.isCallExpression(expr) ? expr.arguments : [];
}

/** Every `@UseGuards(...)` argument on `node`, across every accepted `@UseGuards` decorator it carries. */
function collectUseGuardsArguments(
  node: ts.ClassLikeDeclaration | ts.MethodDeclaration,
  checker: ts.TypeChecker,
): ts.Expression[] {
  const decorators = getDecoratorInfos(node, checker, NEST_COMMON_MODULE);
  const args: ts.Expression[] = [];
  for (const d of decorators) {
    if (d.provenance === 'mismatch') continue;
    if ((d.resolvedName ?? d.name) !== 'UseGuards') continue;
    args.push(...getDecoratorCallArguments(d.node));
  }
  return args;
}

/** Resolves a `@UseGuards(...)` argument to the guard class it statically names — see module doc's resolution scope. */
function resolveGuardClassExpression(arg: ts.Expression): ts.Expression | undefined {
  if (ts.isNewExpression(arg)) return arg.expression;
  if (ts.isIdentifier(arg) || ts.isPropertyAccessExpression(arg)) return arg;
  return undefined;
}

/**
 * Finds `classDecl`'s `canActivate` method — its own, or (bounded) the
 * nearest ancestor's, for a common "shared base guard implements
 * `canActivate`, concrete guards just configure it" pattern. Mirrors
 * `documented.ts`'s ancestor walk in spirit; capped defensively rather than
 * following `heritage.ts`'s existing chains unbounded.
 */
function resolveCanActivateMethod(
  classDecl: ts.ClassLikeDeclaration,
  checker: ts.TypeChecker,
): FunctionDeclWithBody | undefined {
  let current: ts.ClassLikeDeclaration | undefined = classDecl;
  const visited = new Set<ts.ClassLikeDeclaration>();
  for (let depth = 0; depth < MAX_GUARD_HERITAGE_DEPTH && current && !visited.has(current); depth++) {
    visited.add(current);
    const method = current.members.find(
      (m): m is ts.MethodDeclaration =>
        ts.isMethodDeclaration(m) && ts.isIdentifier(m.name) && m.name.text === 'canActivate',
    );
    if (method && isFunctionLikeWithBody(method)) return method;
    current = getBaseClassDeclaration(current, checker);
  }
  return undefined;
}

/**
 * Collects every `401`/`403`-shaped (or whatever a guard actually throws)
 * status reachable from `methodNode`'s and `classNode`'s combined
 * `@UseGuards(...)` — see module doc.
 */
export function collectGuardStatuses(
  methodNode: ts.MethodDeclaration,
  classNode: ts.ClassLikeDeclaration,
  ctx: AnalysisContext,
): GuardFinding[] {
  const guardArgs = [
    ...collectUseGuardsArguments(classNode, ctx.checker),
    ...collectUseGuardsArguments(methodNode, ctx.checker),
  ];
  if (guardArgs.length === 0) return [];

  const results: GuardFinding[] = [];
  // NestJS applies class-level and method-level `@UseGuards(...)` additively,
  // so the same guard class can legitimately appear in both `guardArgs`
  // lists — a common pattern is re-stating an auth guard on a handler for
  // readability even though the whole controller already carries it.
  // De-duplicated by resolved class declaration (not by the guard argument's
  // own AST node) so that case doesn't traverse — and report — the same
  // `canActivate` twice (CodeRabbit review on PR #4).
  const seenGuardClasses = new Set<ts.ClassLikeDeclaration>();
  for (const arg of guardArgs) {
    const classExpr = resolveGuardClassExpression(arg);
    if (!classExpr) continue;
    const guardClass = resolveClassDeclaration(classExpr, ctx.checker);
    if (!guardClass) continue;
    if (seenGuardClasses.has(guardClass)) continue;
    seenGuardClasses.add(guardClass);
    const canActivate = resolveCanActivateMethod(guardClass, ctx.checker);
    if (!canActivate?.name || !ts.isIdentifier(canActivate.name)) continue;

    let symbol: ts.Symbol | undefined;
    try {
      symbol = ctx.checker.getSymbolAtLocation(canActivate.name);
    } catch {
      symbol = undefined;
    }
    if (!symbol) continue;

    // `.unresolvedThrows` (Phase 5 review, finding #6) isn't consumed here:
    // `unresolvable-status` is currently scoped to throws reached through a
    // handler's own body/call graph, not a guard's — widening it to guard
    // throws too is a reasonable future step but wasn't part of this fix.
    const { findings } = collectThrowsFromDeclaration(
      { decl: canActivate, symbol },
      arg,
      ctx,
      ctx.options.maxDepth,
    );
    for (const finding of findings) {
      results.push({
        resolved: finding.resolved,
        source: {
          kind: 'implicit',
          reason: 'guard',
          node: finding.source.node,
          detail: finding.source.via.map((hop) => hop.name).join(' → '),
        },
      });
    }
  }

  return results;
}
