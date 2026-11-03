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
 * Project-local decorators that compose or forward to these (`applyDecorators(...)`,
 * `Doc(404)`) are resolved by `response-wrappers.ts`; ones it cannot read are
 * reported as `DocumentationGap`s and can be described via
 * `AnalysisOptions.responseDecorators`.
 */

import * as ts from 'typescript';
import type {
  AnalysisOptions,
  DocumentationGap,
  DocumentedStatus,
  DocumentedStatusValue,
  StatusRange,
} from './types.js';
import { type WrapperContext, resolveWrapperDecorator } from './response-wrappers.js';
import { getDecoratorInfos } from './decorators.js';
import { isStatusRange, resolveStatusExpression } from './status-value.js';
import { SHORTHAND_RESPONSE_DECORATORS } from './nest-exceptions.js';
import { getBaseClassDeclaration } from './heritage.js';

const SWAGGER_MODULE = '@nestjs/swagger';

function getDecoratorCallArgument(decorator: ts.Decorator): ts.Expression | undefined {
  const expr = decorator.expression;
  return ts.isCallExpression(expr) ? expr.arguments[0] : undefined;
}

/** Resolves `expr` to a numeric status or an `NXX` range literal, where statically possible. */
function resolveStatusLiteralExpression(
  expr: ts.Expression,
  checker: ts.TypeChecker,
): number | StatusRange | undefined {
  if (ts.isStringLiteralLike(expr) && isStatusRange(expr.text)) return expr.text;
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
  if (type.isStringLiteral() && isStatusRange(type.value)) return type.value;
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
    if (propType.isStringLiteral() && isStatusRange(propType.value)) return propType.value;
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

function swaggerStatuses(
  effectiveName: string,
  firstArgument: ts.Expression | undefined,
  checker: ts.TypeChecker,
  options: AnalysisOptions,
): DocumentedStatusValue[] {
  if (effectiveName === 'ApiDefaultResponse') {
    return options.treatDefaultAsWildcard ? ['default'] : [];
  }

  if (effectiveName === 'ApiResponse') {
    const result = resolveApiResponseStatus(firstArgument, checker);
    if (result.status !== undefined) return [result.status];
    if (result.range !== undefined) return [result.range];
    // No explicit `status` and nothing ambiguous (e.g. `@ApiResponse({
    // description: '...' })` with no spread) isn't attributable to any
    // specific code — real `@nestjs/swagger` treats that as documenting
    // 200, but success-code checking is deferred (PLAN §4.1c / Phase 5).
    return result.ambiguous ? ['default'] : [];
  }

  // `Object.hasOwn` guard (not a bare `!== undefined` check on the
  // indexed value): `SHORTHAND_RESPONSE_DECORATORS` is a plain object
  // literal built via `Object.fromEntries`, so it inherits from
  // `Object.prototype`. A decorator import that merely SHARES A NAME with
  // an `Object.prototype` member — `toString`, `valueOf`, `constructor`,
  // `hasOwnProperty`, `isPrototypeOf`, `propertyIsEnumerable`,
  // `toLocaleString` — need not exist in `@nestjs/swagger` at all; writing
  // `import { toString } from '@nestjs/swagger'` and `@toString()` is
  // enough to make `effectiveName === 'toString'`, and an unguarded
  // `SHORTHAND_RESPONSE_DECORATORS['toString']` resolves to
  // `Object.prototype.toString` (a function, so `!== undefined`), which
  // then gets pushed into `results` as a bogus `status` and crashes far
  // downstream code that expects `status` to be a number/string. Found via
  // adversarial review of PR #21.
  return Object.hasOwn(SHORTHAND_RESPONSE_DECORATORS, effectiveName)
    ? [SHORTHAND_RESPONSE_DECORATORS[effectiveName]!]
    : [];
}

function documentedFromNode(
  node: ts.ClassLikeDeclaration | ts.MethodDeclaration,
  checker: ts.TypeChecker,
  level: 'method' | 'class',
  options: AnalysisOptions,
): Documentation {
  const decorators = getDecoratorInfos(node, checker, SWAGGER_MODULE);
  const statuses: DocumentedStatus[] = [];
  const gaps: DocumentationGap[] = [];
  const wrapperContext: WrapperContext = {
    checker,
    options,
    swagger: (effectiveName, call) =>
      swaggerStatuses(effectiveName, call.arguments[0], checker, options),
  };

  for (const d of decorators) {
    if (d.provenance === 'mismatch') {
      const resolved = resolveWrapperDecorator(d.node, d.name, wrapperContext);
      for (const status of resolved.statuses) {
        statuses.push({ status, decorator: d.name, node: d.node, level });
      }
      gaps.push(...resolved.gaps);
      continue;
    }

    const argument = getDecoratorCallArgument(d.node);
    for (const status of swaggerStatuses(d.resolvedName ?? d.name, argument, checker, options)) {
      statuses.push({ status, decorator: d.name, node: d.node, level });
    }
  }

  return { statuses, gaps };
}

interface Documentation {
  statuses: DocumentedStatus[];
  gaps: DocumentationGap[];
}

/**
 * Class-level documentation for `classNode` AND every resolvable ancestor up
 * its `extends` chain (PLAN §4.3 review S1). `visited` guards against a cycle
 * (never possible in valid TS, but cheap insurance against looping forever
 * on malformed input).
 */
function collectClassChain(
  classNode: ts.ClassLikeDeclaration,
  checker: ts.TypeChecker,
  options: AnalysisOptions,
): Documentation {
  const result: Documentation = { statuses: [], gaps: [] };
  const visited = new Set<ts.ClassLikeDeclaration>();
  let current: ts.ClassLikeDeclaration | undefined = classNode;
  while (current !== undefined && !visited.has(current)) {
    visited.add(current);
    const own = documentedFromNode(current, checker, 'class', options);
    result.statuses.push(...own.statuses);
    result.gaps.push(...own.gaps);
    current = getBaseClassDeclaration(current, checker);
  }
  return result;
}

/**
 * Documentation for `methodNode`, merging its own decorators with its
 * class's and every ancestor class's (class-level statuses first, so
 * `statuses[0]` is stable-ish for callers that care, though nothing
 * relies on that order).
 */
export function collectDocumentation(
  methodNode: ts.MethodDeclaration,
  checker: ts.TypeChecker,
  options: AnalysisOptions,
): Documentation {
  const parent: ts.Node | undefined = methodNode.parent;
  const classLevel =
    parent !== undefined && ts.isClassLike(parent)
      ? collectClassChain(parent, checker, options)
      : { statuses: [], gaps: [] };
  const own = documentedFromNode(methodNode, checker, 'method', options);
  return {
    statuses: [...classLevel.statuses, ...own.statuses],
    gaps: [...classLevel.gaps, ...own.gaps],
  };
}

export function getDocumentedStatuses(
  methodNode: ts.MethodDeclaration,
  checker: ts.TypeChecker,
  options: AnalysisOptions,
): DocumentedStatus[] {
  return collectDocumentation(methodNode, checker, options).statuses;
}

export function getDocumentationGaps(
  methodNode: ts.MethodDeclaration,
  checker: ts.TypeChecker,
  options: AnalysisOptions,
): DocumentationGap[] {
  return collectDocumentation(methodNode, checker, options).gaps;
}
