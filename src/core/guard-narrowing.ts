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
 * match, never on "couldn't tell."
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

function safeSymbol(checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined {
  try {
    return checker.getSymbolAtLocation(node);
  } catch {
    return undefined;
  }
}

/**
 * Follows an alias symbol (an imported binding) through to the symbol it
 * actually refers to — same alias-following `heritage.ts`'s
 * `resolveClassDeclaration` does. Needed here because a decorator factory
 * referenced through an `import { OptIn } from '...'` resolves, without
 * this, to the IMPORT SPECIFIER's own declaration (which has no body to
 * scan), not the real `export const OptIn = (...) => SetMetadata(...)` this
 * module needs to look inside.
 */
function resolveAliasedSymbol(symbol: ts.Symbol, checker: ts.TypeChecker): ts.Symbol {
  if ((symbol.flags & ts.SymbolFlags.Alias) === 0) return symbol;
  try {
    const aliased = checker.getAliasedSymbol(symbol);
    if (aliased !== symbol && (aliased.getDeclarations()?.length ?? 0) > 0) return aliased;
  } catch {
    // fall through: stays the alias symbol
  }
  return symbol;
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

/** Resolves an `Identifier` naming a metadata key to a symbol, following an import alias if it is one. */
function resolveKeySymbol(node: ts.Identifier, checker: ts.TypeChecker): ts.Symbol | undefined {
  const sym = safeSymbol(checker, node);
  return sym ? resolveAliasedSymbol(sym, checker) : undefined;
}

/** Every metadata key symbol a `SetMetadata(...)` call anywhere in `node` sets — bounded, see call site. */
function collectSetMetadataKeys(node: ts.Node, checker: ts.TypeChecker, out: Set<ts.Symbol>): void {
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    if (ts.isIdentifier(callee) && callee.text === 'SetMetadata') {
      const keyArg = node.arguments[0];
      if (keyArg && ts.isIdentifier(keyArg)) {
        const sym = resolveKeySymbol(keyArg, checker);
        if (sym) out.add(sym);
      }
    }
  }
  ts.forEachChild(node, (child) => collectSetMetadataKeys(child, checker, out));
}

/**
 * Every metadata key symbol set by a decorator actually applied to
 * `methodNode` or `classNode` — resolves each decorator's callee to its
 * declaration and, ONLY when that declaration is itself a function/arrow
 * (a decorator factory, never a class or an ambient library signature —
 * this bound is what keeps the scan cheap: a factory's body is always a few
 * statements, never an arbitrarily large subtree), scans it for
 * `SetMetadata(...)` calls, including through a wrapper like
 * `applyDecorators(SetMetadata(...), ...)`. A bare `@SetMetadata(KEY, ...)`
 * applied directly (no custom wrapper) is also recognized, since its own
 * call expression already matches `collectSetMetadataKeys` directly.
 */
function collectAppliedMetadataKeys(
  methodNode: ts.MethodDeclaration,
  classNode: ts.ClassLikeDeclaration,
  checker: ts.TypeChecker,
): Set<ts.Symbol> {
  const out = new Set<ts.Symbol>();
  for (const node of [classNode, methodNode]) {
    if (!ts.canHaveDecorators(node)) continue;
    const decorators = ts.getDecorators(node);
    if (!decorators) continue;
    for (const decorator of decorators) {
      if (ts.isCallExpression(decorator.expression)) {
        collectSetMetadataKeys(decorator.expression, checker, out);
      }
      const nameNode = getDecoratorNameNode(decorator);
      const rawSym = safeSymbol(checker, nameNode);
      const sym = rawSym ? resolveAliasedSymbol(rawSym, checker) : undefined;
      for (const decl of sym?.getDeclarations() ?? []) {
        let factoryBody: ts.Node | undefined;
        if (
          ts.isVariableDeclaration(decl) &&
          decl.initializer &&
          (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))
        ) {
          factoryBody = decl.initializer;
        } else if (ts.isFunctionDeclaration(decl) && decl.body) {
          factoryBody = decl;
        }
        if (factoryBody) collectSetMetadataKeys(factoryBody, checker, out);
      }
    }
  }
  return out;
}

/** Recognizes `<reflector>.getAllAndOverride(KEY, ...)` / `.get(KEY, ...)`, directly or via a local variable. */
function metadataKeySymbolForCondition(
  expr: ts.Expression,
  checker: ts.TypeChecker,
): ts.Symbol | undefined {
  let current = expr;
  while (ts.isParenthesizedExpression(current)) current = current.expression;

  if (ts.isIdentifier(current)) {
    const sym = safeSymbol(checker, current);
    const decl = sym?.valueDeclaration;
    if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
      return metadataKeySymbolForCondition(decl.initializer, checker);
    }
    return undefined;
  }

  if (!ts.isCallExpression(current) || !ts.isPropertyAccessExpression(current.expression)) {
    return undefined;
  }
  const methodName = current.expression.name.text;
  if (methodName !== 'getAllAndOverride' && methodName !== 'get') return undefined;
  const keyArg = current.arguments[0];
  if (!keyArg || !ts.isIdentifier(keyArg)) return undefined;
  return resolveKeySymbol(keyArg, checker);
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

/** `true` only when `expr` is a recognized HTTP-method gate that PROVABLY excludes `httpMethod`. */
function isProvablyFalseHttpMethodCheck(
  expr: ts.Expression,
  requestSymbols: ReadonlySet<ts.Symbol>,
  httpMethod: HttpMethod,
  checker: ts.TypeChecker,
): boolean {
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
  appliedKeys: ReadonlySet<ts.Symbol>;
  requestSymbols: ReadonlySet<ts.Symbol>;
  httpMethod: HttpMethod;
  checker: ts.TypeChecker;
}

/** `true` when ANY `&&`-operand of `expr` is provably false — sufficient to make the whole conjunction false. */
function isConditionProvablyFalse(expr: ts.Expression, ctx: NarrowingContext): boolean {
  for (const operand of flattenAnd(expr)) {
    const metadataKey = metadataKeySymbolForCondition(operand, ctx.checker);
    if (metadataKey !== undefined && !ctx.appliedKeys.has(metadataKey)) return true;
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
  let current: ts.Node | undefined = node;
  while (current) {
    if (excluded.has(current)) return true;
    current = current.parent;
  }
  return false;
}
