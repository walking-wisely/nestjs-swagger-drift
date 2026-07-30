/**
 * Documented status codes for a handler (PLAN §4.3): merges method-level
 * decorators with class-level `@ApiResponse`-family decorators from the
 * handler's class AND every ancestor class up the `extends` chain (Phase 2
 * review S1) — `@nestjs/swagger` reads class-level metadata via
 * `Reflect.getMetadata`, which walks the prototype chain, so a class-level
 * `@ApiNotFoundResponse` on `BaseController` genuinely documents
 * `DerivedController`'s handlers too.
 *
 * Covers:
 * - `@ApiResponse({ status: 404 })` / `@ApiResponse({ status: HttpStatus.NOT_FOUND })`.
 * - `{ status }` shorthand property assignment, a `status` arriving only via
 *   `{ ...SOME_CONST_WITH_STATUS }` (resolved via the argument's type when
 *   the AST alone doesn't show it directly), and an argument that's a
 *   reference to a module-level `const OPTS = { status: 404 }` object
 *   (Phase 2 review S2).
 * - The `'1XX'`..`'5XX'` range-wildcard forms of `ApiResponseOptions.status`
 *   (Phase 2 review S2) — documents every status in that range.
 * - The full shorthand family (`@ApiOkResponse`, `@ApiNotFoundResponse`, ...
 *   — table in `nest-exceptions.ts`, derived from `@nestjs/swagger`'s export
 *   list).
 * - `@ApiDefaultResponse`, a wildcard governed by
 *   `AnalysisOptions.treatDefaultAsWildcard` (default `false` — see
 *   `DocumentedStatus`'s doc comment in `types.ts`: "satisfies nothing
 *   specific *by default*").
 *
 * Explicitly NOT covered in Phase 2 (PLAN §4.3's "V1 gap"): composed
 * decorators built with `applyDecorators(ApiNotFoundResponse(), ...)`. Such
 * a composed decorator is not literally named `ApiResponse`/a shorthand at
 * the use site, so it is invisible here — a handler documented only that
 * way will look undocumented. Documented, not silently worked around.
 */

import * as ts from 'typescript';
import type { AnalysisOptions, DocumentedStatus, StatusRange } from './types.js';
import { getDecoratorInfos } from './decorators.js';
import { resolveStatusExpression } from './status-value.js';
import { SHORTHAND_RESPONSE_DECORATORS } from './nest-exceptions.js';
import { getBaseClassDeclaration } from './heritage.js';

const SWAGGER_MODULE = '@nestjs/swagger';
const RANGE_STATUS_PATTERN = /^[1-5]XX$/;

function getDecoratorCallArgument(decorator: ts.Decorator): ts.Expression | undefined {
  const expr = decorator.expression;
  return ts.isCallExpression(expr) ? expr.arguments[0] : undefined;
}

function isRangeStatusLiteral(text: string): text is StatusRange {
  return RANGE_STATUS_PATTERN.test(text);
}

/** Resolves `expr` to a numeric status or an `NXX` range literal, where statically possible. */
function resolveStatusLiteralExpression(
  expr: ts.Expression,
  checker: ts.TypeChecker,
): number | StatusRange | undefined {
  if (ts.isStringLiteralLike(expr) && isRangeStatusLiteral(expr.text)) return expr.text;
  return resolveStatusExpression(expr, checker);
}

/**
 * If `expr` is a bare identifier referencing a `const OPTS = { ... }`
 * declaration, returns that object literal — lets `@ApiResponse(OPTS)`
 * (Phase 2 review S2) be analyzed the same way as an inline object literal.
 */
function resolveIdentifierObjectLiteral(
  expr: ts.Identifier,
  checker: ts.TypeChecker,
): ts.ObjectLiteralExpression | undefined {
  let symbol: ts.Symbol | undefined;
  try {
    symbol = checker.getSymbolAtLocation(expr);
  } catch {
    symbol = undefined;
  }
  if (!symbol) return undefined;
  for (const decl of symbol.getDeclarations() ?? []) {
    if (
      ts.isVariableDeclaration(decl) &&
      decl.initializer &&
      ts.isObjectLiteralExpression(decl.initializer)
    ) {
      return decl.initializer;
    }
  }
  return undefined;
}

/**
 * Scans `obj`'s own (non-spread) properties for a `status: <value>` /
 * `{ status }` entry. Returns either the value expression (for a regular
 * `status: <expr>` property assignment) or the `ShorthandPropertyAssignment`
 * node itself (for `{ status }`) — a shorthand's `name` identifier can't be
 * fed through the normal expression-typing path (see
 * `resolveShorthandStatusValue`'s doc comment for why), plus whether a
 * spread element is present anywhere in the object (relevant when no direct
 * `status` property is found — see `resolveApiResponseStatus`).
 */
function findDirectStatusProperty(obj: ts.ObjectLiteralExpression): {
  valueExpr: ts.Expression | undefined;
  shorthandProp: ts.ShorthandPropertyAssignment | undefined;
  hasSpread: boolean;
} {
  let hasSpread = false;
  for (const prop of obj.properties) {
    if (ts.isSpreadAssignment(prop)) {
      hasSpread = true;
      continue;
    }
    const isStatusName =
      (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) &&
      ((ts.isIdentifier(prop.name) && prop.name.text === 'status') ||
        (ts.isStringLiteral(prop.name) && prop.name.text === 'status'));
    if (!isStatusName) continue;
    if (ts.isShorthandPropertyAssignment(prop)) {
      return { valueExpr: undefined, shorthandProp: prop, hasSpread };
    }
    return { valueExpr: prop.initializer, shorthandProp: undefined, hasSpread };
  }
  return { valueExpr: undefined, shorthandProp: undefined, hasSpread };
}

/**
 * Resolves `{ status }`'s value where `status` is a shorthand property
 * assignment. `checker.getTypeAtLocation(prop.name)` — the normal path any
 * other expression goes through — returns the property's widened apparent
 * type (`number`) here, not the referenced variable's narrowed literal type,
 * because `prop.name` doubles as both the property key and the value
 * reference; the checker's dedicated
 * `getShorthandAssignmentValueSymbol`/`getTypeOfSymbolAtLocation` pair is the
 * documented way to get the actual referenced value's (narrowed) type.
 */
function resolveShorthandStatusValue(
  prop: ts.ShorthandPropertyAssignment,
  checker: ts.TypeChecker,
): number | StatusRange | undefined {
  const symbol = checker.getShorthandAssignmentValueSymbol(prop);
  if (!symbol) return undefined;
  const type = checker.getTypeOfSymbolAtLocation(symbol, prop);
  if (type.isNumberLiteral()) return type.value;
  if (type.isStringLiteral() && isRangeStatusLiteral(type.value)) return type.value;
  return undefined;
}

/**
 * Last-resort status resolution via `expr`'s own TYPE rather than its
 * syntax — the only way to see a `status` that arrives purely through a
 * spread of something whose type happens to be literal (Phase 2 review S2).
 */
function resolveStatusViaExpressionType(
  expr: ts.Expression,
  checker: ts.TypeChecker,
): number | StatusRange | undefined {
  try {
    const type = checker.getTypeAtLocation(expr);
    const propSymbol = type.getProperty('status');
    if (!propSymbol) return undefined;
    const propType = checker.getTypeOfSymbolAtLocation(propSymbol, expr);
    if (propType.isNumberLiteral()) return propType.value;
    if (propType.isStringLiteral() && isRangeStatusLiteral(propType.value)) return propType.value;
  } catch {
    // fall through
  }
  return undefined;
}

interface ApiResponseStatusResult {
  status?: number;
  range?: StatusRange;
  /**
   * The argument had a spread and no concrete status/range could be pinned
   * down anywhere. FP-safe direction (Phase 2 review S2): treat as "might
   * document anything" (a full wildcard), not "documents nothing" — the
   * opposite bias from the *producible* side, where uncertainty must drop
   * the finding. `documentedFromNode` turns this into `status: 'default'`.
   */
  ambiguous: boolean;
}

function resolveApiResponseStatus(
  arg: ts.Expression | undefined,
  checker: ts.TypeChecker,
): ApiResponseStatusResult {
  if (!arg) return { ambiguous: false };

  const objectLiteral = ts.isObjectLiteralExpression(arg)
    ? arg
    : ts.isIdentifier(arg)
      ? resolveIdentifierObjectLiteral(arg, checker)
      : undefined;

  if (objectLiteral) {
    const { valueExpr, shorthandProp, hasSpread } = findDirectStatusProperty(objectLiteral);
    if (valueExpr) {
      const resolved = resolveStatusLiteralExpression(valueExpr, checker);
      if (typeof resolved === 'number') return { status: resolved, ambiguous: false };
      if (typeof resolved === 'string') return { range: resolved, ambiguous: false };
    }
    if (shorthandProp) {
      const resolved = resolveShorthandStatusValue(shorthandProp, checker);
      if (typeof resolved === 'number') return { status: resolved, ambiguous: false };
      if (typeof resolved === 'string') return { range: resolved, ambiguous: false };
    }
    if (hasSpread) {
      const viaType = resolveStatusViaExpressionType(arg, checker);
      if (typeof viaType === 'number') return { status: viaType, ambiguous: false };
      if (typeof viaType === 'string') return { range: viaType, ambiguous: false };
      return { ambiguous: true };
    }
    return { ambiguous: false };
  }

  // Not statically an object literal, and not a `const` reference to one (a
  // ternary, a function call, ...) — try the argument's own type as a last
  // resort; otherwise this genuinely documents nothing specific.
  const viaType = resolveStatusViaExpressionType(arg, checker);
  if (typeof viaType === 'number') return { status: viaType, ambiguous: false };
  if (typeof viaType === 'string') return { range: viaType, ambiguous: false };
  return { ambiguous: false };
}

function documentedFromNode(
  node: ts.ClassLikeDeclaration | ts.MethodDeclaration,
  checker: ts.TypeChecker,
  level: 'method' | 'class',
  options: AnalysisOptions,
): DocumentedStatus[] {
  const decorators = getDecoratorInfos(node, checker, SWAGGER_MODULE);
  const results: DocumentedStatus[] = [];

  for (const d of decorators) {
    if (d.provenance === 'mismatch') continue;
    const effectiveName = d.resolvedName ?? d.name;

    if (effectiveName === 'ApiDefaultResponse') {
      if (options.treatDefaultAsWildcard) {
        results.push({ status: 'default', decorator: d.name, node: d.node, level });
      }
      continue;
    }

    if (effectiveName === 'ApiResponse') {
      const result = resolveApiResponseStatus(getDecoratorCallArgument(d.node), checker);
      if (result.status !== undefined) {
        results.push({ status: result.status, decorator: d.name, node: d.node, level });
      } else if (result.range !== undefined) {
        results.push({ status: result.range, decorator: d.name, node: d.node, level });
      } else if (result.ambiguous) {
        results.push({ status: 'default', decorator: d.name, node: d.node, level });
      }
      // No explicit `status` and nothing ambiguous (e.g. `@ApiResponse({
      // description: '...' })` with no spread) isn't attributable to any
      // specific code — real `@nestjs/swagger` treats that as documenting
      // 200, but success-code checking is deferred (PLAN §4.1c / Phase 5).
      continue;
    }

    const shorthandStatus = SHORTHAND_RESPONSE_DECORATORS[effectiveName];
    if (shorthandStatus !== undefined) {
      results.push({ status: shorthandStatus, decorator: d.name, node: d.node, level });
    }
  }

  return results;
}

/**
 * Class-level statuses for `classNode` AND every resolvable ancestor up its
 * `extends` chain (PLAN §4.3 review S1). `visited` guards against a cycle
 * (never possible in valid TS, but cheap insurance against looping forever
 * on malformed input).
 */
function collectClassChainStatuses(
  classNode: ts.ClassLikeDeclaration,
  checker: ts.TypeChecker,
  options: AnalysisOptions,
): DocumentedStatus[] {
  const results: DocumentedStatus[] = [];
  const visited = new Set<ts.ClassLikeDeclaration>();
  let current: ts.ClassLikeDeclaration | undefined = classNode;
  while (current !== undefined && !visited.has(current)) {
    visited.add(current);
    results.push(...documentedFromNode(current, checker, 'class', options));
    current = getBaseClassDeclaration(current, checker);
  }
  return results;
}

/**
 * Documented statuses for `methodNode`, merging its own decorators with its
 * class's and every ancestor class's (class-level statuses first, so
 * `documented[0]` is stable-ish for callers that care, though nothing
 * relies on that order).
 */
export function getDocumentedStatuses(
  methodNode: ts.MethodDeclaration,
  checker: ts.TypeChecker,
  options: AnalysisOptions,
): DocumentedStatus[] {
  const parent: ts.Node | undefined = methodNode.parent;
  const classStatuses =
    parent !== undefined && ts.isClassLike(parent)
      ? collectClassChainStatuses(parent, checker, options)
      : [];
  const methodStatuses = documentedFromNode(methodNode, checker, 'method', options);
  return [...classStatuses, ...methodStatuses];
}
