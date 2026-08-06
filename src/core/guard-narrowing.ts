/**
 * Handler-specific narrowing for `guards.ts` (adversarial-testing finding,
 * post-Phase-6). `checkGuards` resolves a `@UseGuards(...)` class's
 * `canActivate` and walks EVERY throw reachable from it, with no regard for
 * whether the specific handler being analyzed can actually reach that throw
 * — `canActivate`'s own body is often conditional in ways this tool CAN
 * verify statically for a given handler, and a guard that branches on one of
 * those two recognized shapes gets stamped onto every handler under it
 * whether or not that handler's branch is even live:
 *
 * 1. **Decorator-metadata gates** — `this.reflector.getAllAndOverride(KEY, [
 *    context.getHandler(), context.getClass() ])` (or `.get(KEY, ...)`),
 *    the canonical NestJS way for a guard to read a custom decorator
 *    (`@Roles(...)`, `@Public()`, ...). When a branch is gated on the
 *    truthiness of such a read, and the ANALYZED handler/class carry no
 *    decorator that sets that same metadata key (traced through a custom
 *    decorator factory wrapping `SetMetadata`, or a bare `@SetMetadata(KEY,
 *    ...)`), that branch is provably dead for this handler.
 * 2. **HTTP-method gates** — `SOME_SET.has(request.method)` /
 *    `request.method === 'POST'`-shaped conditions on the Express/Fastify
 *    request pulled off `ExecutionContext` via a `.getRequest(...)` call.
 *    The analyzed handler's own HTTP method is already a first-class fact
 *    this tool discovers (`routes.ts`), so this is evaluable exactly like
 *    the metadata gate above.
 *
 * Real, verified false-positive: a rate-limiting-shaped guard attached at
 * the controller class level, whose `canActivate` only enforces a limit for
 * a handler-level opt-in decorator OR for write HTTP methods, reported its
 * implicit status on a bare `@Get()` handler carrying neither — a status the
 * guard's own code can never produce for that handler.
 *
 * ## Deliberately narrow, deliberately one-directional
 *
 * Same "silence over noise" bias as the rest of this package, applied in the
 * OPPOSITE direction: `checkGuards` itself only ever reports a status it
 * found a real throw for (never invents one), but THIS module only ever
 * SUPPRESSES a branch it can prove, with both feet, is dead for this
 * specific handler — anything ambiguous (an `||`, a condition neither
 * pattern recognizes, a gate buried in a called helper rather than
 * `canActivate`'s own top-level body) is left alone, falling back to
 * today's behavior (assume reachable). Getting this wrong in the suppressing
 * direction hides a real finding, which is a worse failure than the noise it
 * fixes — every recognizer below only narrows on a positive, high-confidence
 * match, never on "couldn't tell." Concretely (code-review round, all
 * verified against a failing probe before the fix):
 *
 * - Pattern 1 requires the receiver's TYPE to be named `Reflector`
 *   (`isReflectorReceiver`) — `this.blocked.get(key)` on a plain `Map` is
 *   not a metadata read and must never be treated as one, even though it
 *   matches `.get(IDENT, ...)` syntactically.
 * - A metadata key is matched by its resolved STRING VALUE when one is
 *   statically known (`resolveKeyIdentity`), not only by symbol identity —
 *   `SetMetadata('roles', ...)` written as a literal on one side and read
 *   via a shared `ROLES_KEY` const on the other name the same key and must
 *   still match; symbol identity is the fallback for a key that never
 *   resolves to a literal.
 * - `collectAppliedMetadataKeys` follows a decorator factory that calls
 *   ANOTHER decorator factory (`applyDecorators(Roles('admin'))`), not only
 *   a factory that calls `SetMetadata` directly — bounded by
 *   `MAX_FACTORY_RESOLUTION_DEPTH` and a `seen` set (factories are never
 *   deeply nested in practice; the bound is a defensive backstop, not a
 *   realistic ceiling).
 * - Pattern 2 never narrows for `httpMethod: 'ALL'` — `@All()`'s real
 *   semantics aren't knowable from the decorator alone (same reasoning
 *   `success.ts` already applies to it), so treating it as excluded from
 *   every concrete-method set would be a guess, not a proof.
 *
 * Deliberately scoped to `canActivate`'s OWN top-level body — not threaded
 * through the call graph into whatever `canActivate` calls. A guard that
 * moves this branching into a helper method isn't narrowed by this module;
 * that's an honest, documented limitation (see `guards.ts`'s use site),
 * consistent with every other stopping point in this codebase, not a
 * soundness bug.
 */

import * as ts from 'typescript';
import type { HttpMethod } from './types.js';
import { getDecoratorNameNode } from './decorators.js';
import { resolveAliasedSymbol } from './heritage.js';

function safeSymbol(checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined {
  try {
    return checker.getSymbolAtLocation(node);
  } catch {
    return undefined;
  }
}

function isNestedFunctionLikeOrClass(node: ts.Node): boolean {
  return (
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isClassLike(node)
  );
}

// --- Pattern 1: decorator-metadata gates ------------------------------------

/**
 * A metadata key's identity: its resolved literal string value when one is
 * statically known, ALWAYS alongside the symbol actually written at the use
 * site (module doc's "matched by resolved string value ... symbol identity
 * is the fallback"). Two identities match if either their `literal`s or
 * their `symbol`s agree — see `keyIdentitiesMatch`.
 */
interface KeyIdentity {
  symbol: ts.Symbol;
  literal: string | undefined;
}

/** Resolves an identifier to a string-literal VALUE where statically possible — mirrors `decorators.ts`'s own resolver. */
function resolveStringLiteralValue(expr: ts.Expression, checker: ts.TypeChecker): string | undefined {
  if (ts.isStringLiteralLike(expr)) return expr.text;
  if (ts.isIdentifier(expr)) {
    const sym = safeSymbol(checker, expr);
    const decl = sym ? resolveAliasedSymbol(sym, checker).valueDeclaration : undefined;
    if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
      return resolveStringLiteralValue(decl.initializer, checker);
    }
    try {
      const type = checker.getTypeAtLocation(expr);
      if (type.isStringLiteral()) return type.value;
    } catch {
      // falls through to undefined
    }
  }
  return undefined;
}

function resolveKeyIdentity(keyArg: ts.Expression, checker: ts.TypeChecker): KeyIdentity | undefined {
  if (!ts.isIdentifier(keyArg) && !ts.isStringLiteralLike(keyArg)) return undefined;
  const literal = resolveStringLiteralValue(keyArg, checker);
  if (!ts.isIdentifier(keyArg)) {
    // A literal with no identifier to key a symbol off — synthesize nothing;
    // literal-only matching still works via `keyIdentitiesMatch`'s OR.
    if (literal === undefined) return undefined;
    return { symbol: NO_SYMBOL, literal };
  }
  const rawSym = safeSymbol(checker, keyArg);
  if (!rawSym) return literal === undefined ? undefined : { symbol: NO_SYMBOL, literal };
  return { symbol: resolveAliasedSymbol(rawSym, checker), literal };
}

/** Placeholder for "no real symbol" (a bare string-literal key) — never equal to any real `ts.Symbol`. */
const NO_SYMBOL = {} as ts.Symbol;

function keyIdentitiesMatch(a: KeyIdentity, b: KeyIdentity): boolean {
  if (a.literal !== undefined && a.literal === b.literal) return true;
  return a.symbol !== NO_SYMBOL && a.symbol === b.symbol;
}

const MAX_FACTORY_RESOLUTION_DEPTH = 8;

function functionLikeBodyOf(decl: ts.Declaration): ts.Node | undefined {
  if (
    ts.isVariableDeclaration(decl) &&
    decl.initializer &&
    (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))
  ) {
    return decl.initializer;
  }
  if (ts.isFunctionDeclaration(decl) && decl.body) return decl;
  return undefined;
}

/**
 * Every metadata key identity a `SetMetadata(...)` call anywhere in `node`
 * sets, following calls to OTHER locally-resolvable decorator factories too
 * (module doc's `applyDecorators(Roles('admin'))` case) — bounded by
 * `MAX_FACTORY_RESOLUTION_DEPTH` and `seen` (cycle guard for two factories
 * that call each other, which shouldn't happen but costs nothing to guard).
 * Scoped to genuine factory shapes only (`functionLikeBodyOf`'s check) —
 * never recurses into a class, an ambient library signature, or anything
 * else whose subtree could be arbitrarily large, which is what keeps this
 * cheap regardless of what a decorator argument happens to resolve to.
 *
 * `depth` counts FACTORY-RESOLUTION hops only — incremented exclusively on
 * the `collectMetadataKeys(body, ...)` recursion into a newly-resolved
 * factory's own body, NOT on the plain structural `forEachChild` walk over
 * `node`'s own subtree (verification round, real bug: incrementing on every
 * AST step meant ordinary syntax nesting — `FunctionDeclaration` → `Block` →
 * `ReturnStatement` → `CallExpression` is already 4 steps per factory level
 * — exhausted the budget well before `MAX_FACTORY_RESOLUTION_DEPTH` factory
 * levels were actually reached, silently missing a key a realistic
 * `function`-bodied (as opposed to single-expression-arrow) factory sets,
 * which then wrongly narrowed away a real finding).
 */
function collectMetadataKeys(
  node: ts.Node,
  checker: ts.TypeChecker,
  out: KeyIdentity[],
  seen: Set<ts.Declaration>,
  depth: number,
): void {
  if (depth > MAX_FACTORY_RESOLUTION_DEPTH) return;
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    if (ts.isIdentifier(callee)) {
      if (callee.text === 'SetMetadata') {
        const keyArg = node.arguments[0];
        const identity = keyArg && resolveKeyIdentity(keyArg, checker);
        if (identity) out.push(identity);
      } else {
        const rawSym = safeSymbol(checker, callee);
        const sym = rawSym ? resolveAliasedSymbol(rawSym, checker) : undefined;
        for (const decl of sym?.getDeclarations() ?? []) {
          if (seen.has(decl)) continue;
          const body = functionLikeBodyOf(decl);
          if (!body) continue;
          seen.add(decl);
          collectMetadataKeys(body, checker, out, seen, depth + 1);
        }
      }
    }
  }
  ts.forEachChild(node, (child) => collectMetadataKeys(child, checker, out, seen, depth));
}

/** Every metadata key identity set by a decorator actually applied to `methodNode` or `classNode`. */
function collectAppliedMetadataKeys(
  methodNode: ts.MethodDeclaration,
  classNode: ts.ClassLikeDeclaration,
  checker: ts.TypeChecker,
): KeyIdentity[] {
  const out: KeyIdentity[] = [];
  const seen = new Set<ts.Declaration>();
  for (const node of [classNode, methodNode]) {
    if (!ts.canHaveDecorators(node)) continue;
    const decorators = ts.getDecorators(node);
    if (!decorators) continue;
    for (const decorator of decorators) {
      // A bare `@SetMetadata(KEY, ...)` applied directly (no custom wrapper).
      if (ts.isCallExpression(decorator.expression)) {
        collectMetadataKeys(decorator.expression, checker, out, seen, 0);
      }
      const nameNode = getDecoratorNameNode(decorator);
      const rawSym = safeSymbol(checker, nameNode);
      const sym = rawSym ? resolveAliasedSymbol(rawSym, checker) : undefined;
      for (const decl of sym?.getDeclarations() ?? []) {
        if (seen.has(decl)) continue;
        const body = functionLikeBodyOf(decl);
        if (!body) continue;
        seen.add(decl);
        collectMetadataKeys(body, checker, out, seen, 0);
      }
    }
  }
  return out;
}

/** `true` when `expr`'s TYPE is named `Reflector` — see module doc's "requires the receiver's TYPE". */
function isReflectorReceiver(expr: ts.Expression, checker: ts.TypeChecker): boolean {
  try {
    const type = checker.getTypeAtLocation(expr);
    const symbol = type.getSymbol() ?? type.aliasSymbol;
    return symbol?.getName() === 'Reflector';
  } catch {
    return false;
  }
}

/** Recognizes `<Reflector instance>.getAllAndOverride(KEY, ...)` / `.get(KEY, ...)`, directly or via a local variable. */
function metadataKeyIdentityForCondition(
  expr: ts.Expression,
  checker: ts.TypeChecker,
): KeyIdentity | undefined {
  let current = expr;
  while (ts.isParenthesizedExpression(current)) current = current.expression;

  if (ts.isIdentifier(current)) {
    const sym = safeSymbol(checker, current);
    const decl = sym?.valueDeclaration;
    if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
      return metadataKeyIdentityForCondition(decl.initializer, checker);
    }
    return undefined;
  }

  if (!ts.isCallExpression(current) || !ts.isPropertyAccessExpression(current.expression)) {
    return undefined;
  }
  const methodName = current.expression.name.text;
  if (methodName !== 'getAllAndOverride' && methodName !== 'get') return undefined;
  if (!isReflectorReceiver(current.expression.expression, checker)) return undefined;
  const keyArg = current.arguments[0];
  if (!keyArg) return undefined;
  return resolveKeyIdentity(keyArg, checker);
}

// --- Pattern 2: HTTP-method gates -------------------------------------------

/** Every local variable bound to `<something>.getRequest(...)` inside `body` — see module doc, pattern 2. */
function findRequestVariableSymbols(body: ts.Block, checker: ts.TypeChecker): Set<ts.Symbol> {
  const out = new Set<ts.Symbol>();
  function visit(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isPropertyAccessExpression(node.initializer.expression) &&
      node.initializer.expression.name.text === 'getRequest'
    ) {
      const sym = safeSymbol(checker, node.name);
      if (sym) out.add(sym);
    }
    if (isNestedFunctionLikeOrClass(node)) return;
    ts.forEachChild(node, visit);
  }
  visit(body);
  return out;
}

function isRequestMethodAccess(
  expr: ts.Expression,
  requestSymbols: ReadonlySet<ts.Symbol>,
  checker: ts.TypeChecker,
): boolean {
  if (!ts.isPropertyAccessExpression(expr) || expr.name.text !== 'method') return false;
  const sym = safeSymbol(checker, expr.expression);
  return sym !== undefined && requestSymbols.has(sym);
}

/** Resolves a `Set`/array-of-string-literals expression to its literal contents, where statically possible. */
function resolveStringLiteralSet(expr: ts.Expression, checker: ts.TypeChecker): Set<string> | undefined {
  if (ts.isArrayLiteralExpression(expr)) {
    const out = new Set<string>();
    for (const el of expr.elements) {
      if (!ts.isStringLiteralLike(el)) return undefined;
      out.add(el.text);
    }
    return out;
  }
  if (ts.isNewExpression(expr) && ts.isIdentifier(expr.expression) && expr.expression.text === 'Set') {
    const arg = expr.arguments?.[0];
    return arg ? resolveStringLiteralSet(arg, checker) : new Set();
  }
  if (ts.isIdentifier(expr)) {
    const sym = safeSymbol(checker, expr);
    const decl = sym?.valueDeclaration;
    if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
      return resolveStringLiteralSet(decl.initializer, checker);
    }
  }
  return undefined;
}

/**
 * `true` only when `expr` is a recognized HTTP-method gate that PROVABLY
 * excludes `httpMethod`. Always `false` for `httpMethod: 'ALL'` — module
 * doc's "never narrows for `@All()`": its real semantics aren't knowable
 * from the decorator alone, so treating it as excluded from every
 * concrete-method set would be a guess.
 */
function isProvablyFalseHttpMethodCheck(
  expr: ts.Expression,
  requestSymbols: ReadonlySet<ts.Symbol>,
  httpMethod: HttpMethod,
  checker: ts.TypeChecker,
): boolean {
  if (httpMethod === 'ALL') return false;

  if (ts.isCallExpression(expr) && ts.isPropertyAccessExpression(expr.expression)) {
    const memberName = expr.expression.name.text;
    if (memberName === 'has' || memberName === 'includes') {
      const arg = expr.arguments[0];
      if (arg && isRequestMethodAccess(arg, requestSymbols, checker)) {
        const set = resolveStringLiteralSet(expr.expression.expression, checker);
        if (set && !set.has(httpMethod)) return true;
      }
    }
  }
  if (ts.isBinaryExpression(expr)) {
    const op = expr.operatorToken.kind;
    const isEquals =
      op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken;
    const isNotEquals =
      op === ts.SyntaxKind.ExclamationEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken;
    if (isEquals || isNotEquals) {
      const [methodSide, literalSide] = isRequestMethodAccess(expr.left, requestSymbols, checker)
        ? [expr.left, expr.right]
        : [expr.right, expr.left];
      if (isRequestMethodAccess(methodSide, requestSymbols, checker) && ts.isStringLiteralLike(literalSide)) {
        return isEquals ? literalSide.text !== httpMethod : literalSide.text === httpMethod;
      }
    }
  }
  return false;
}

// --- Combining both patterns over an `if` condition -------------------------

/** Flattens a right-associated `&&` chain into its operands — `||` is deliberately NOT flattened (see module doc). */
function flattenAnd(expr: ts.Expression): ts.Expression[] {
  let current = expr;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
    return [...flattenAnd(current.left), ...flattenAnd(current.right)];
  }
  return [current];
}

interface NarrowingContext {
  appliedKeys: readonly KeyIdentity[];
  requestSymbols: ReadonlySet<ts.Symbol>;
  httpMethod: HttpMethod;
  checker: ts.TypeChecker;
}

/** `true` when ANY `&&`-operand of `expr` is provably false — sufficient to make the whole conjunction false. */
function isConditionProvablyFalse(expr: ts.Expression, ctx: NarrowingContext): boolean {
  for (const operand of flattenAnd(expr)) {
    const metadataKey = metadataKeyIdentityForCondition(operand, ctx.checker);
    if (metadataKey !== undefined && !ctx.appliedKeys.some((k) => keyIdentitiesMatch(k, metadataKey))) {
      return true;
    }
    if (isProvablyFalseHttpMethodCheck(operand, ctx.requestSymbols, ctx.httpMethod, ctx.checker)) {
      return true;
    }
  }
  return false;
}

function collectExcludedRoots(node: ts.Node, ctx: NarrowingContext, out: Set<ts.Node>): void {
  if (isNestedFunctionLikeOrClass(node)) return;
  if (ts.isIfStatement(node)) {
    if (isConditionProvablyFalse(node.expression, ctx)) {
      out.add(node.thenStatement);
    } else {
      collectExcludedRoots(node.thenStatement, ctx, out);
    }
    if (node.elseStatement) collectExcludedRoots(node.elseStatement, ctx, out);
    return;
  }
  ts.forEachChild(node, (child) => collectExcludedRoots(child, ctx, out));
}

/**
 * Every statement inside `canActivateBody` that is provably unreachable for
 * EVERY handler in `handlerHttpMethods` (a method carrying more than one HTTP
 * decorator, e.g. both `@Get()` and `@Post()`, is narrowed only where ALL of
 * its handlers agree a branch is dead — intersecting rather than narrowing
 * per-handler keeps `guards.ts`'s shared per-method computation sound without
 * threading handler identity through it; see `guards.ts`'s call site).
 */
export function computeExcludedGuardBranches(
  canActivateBody: ts.Block,
  methodNode: ts.MethodDeclaration,
  classNode: ts.ClassLikeDeclaration,
  handlerHttpMethods: readonly HttpMethod[],
  checker: ts.TypeChecker,
): ReadonlySet<ts.Node> {
  if (handlerHttpMethods.length === 0) return new Set();

  const appliedKeys = collectAppliedMetadataKeys(methodNode, classNode, checker);
  const requestSymbols = findRequestVariableSymbols(canActivateBody, checker);

  let excluded: Set<ts.Node> | undefined;
  for (const httpMethod of handlerHttpMethods) {
    const forThisMethod = new Set<ts.Node>();
    collectExcludedRoots(
      canActivateBody,
      { appliedKeys, requestSymbols, httpMethod, checker },
      forThisMethod,
    );
    excluded =
      excluded === undefined
        ? forThisMethod
        : new Set([...excluded].filter((node) => forThisMethod.has(node)));
  }
  return excluded ?? new Set();
}

/** Whether `node` (or any ancestor) is one of `excluded`'s roots — see `computeExcludedGuardBranches`. */
export function isNodeInExcludedGuardBranch(node: ts.Node, excluded: ReadonlySet<ts.Node>): boolean {
  if (excluded.size === 0) return false;
  let current: ts.Node | undefined = node;
  while (current) {
    if (excluded.has(current)) return true;
    current = current.parent;
  }
  return false;
}
