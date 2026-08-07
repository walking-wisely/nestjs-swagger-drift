/**
 * Pure helpers for reading NestJS routing decorators (`@Controller`, the
 * `@Get`/`@Post`/... family) off a `ts.ClassLikeDeclaration` or
 * `ts.MethodDeclaration`, plus verifying they actually come from
 * `@nestjs/common` rather than a same-named local symbol.
 *
 * PLAN.md §2.1: pure functions over `(node, ctx)`. No filesystem, no
 * `ts.Program` construction — the caller supplies a `ts.TypeChecker`.
 *
 * ## Provenance strictness (see this module's `Provenance` type)
 *
 * The plan asks for decorator identity to be verified via the type checker
 * rather than by name alone, since a project could have its own unrelated
 * `function Get(...)`. This module does exactly that: it resolves the
 * decorator identifier's symbol and checks whether its declaration lives
 * under the target module (`@nestjs/common` by default — see
 * `isDeclarationFromModule`, generalized so Phase 2 can reuse this for
 * `@nestjs/swagger`) — either the real published package
 * (`node_modules/<module>/...`) or an ambient `declare module '<module>'
 * { ... }` block in any `.d.ts`, wherever that file lives.
 *
 * `test/fixtures/**` deliberately don't have `@nestjs/common` installed
 * (see PLAN.md and the task brief); they instead ship a small
 * `types/nestjs.d.ts` using the ambient-module form above, which the second
 * check recognizes, so provenance there still comes back `'verified'`.
 *
 * Two distinct "checker couldn't fully pin this down" cases both collapse to
 * `'unverified'`, not `'mismatch'`:
 *
 * 1. The checker can't resolve the identifier's symbol at all (no type
 *    information available, e.g. a lone `.ts` file with no module
 *    resolution for the decorator in scope).
 * 2. The identifier resolves to an *unresolved import* — `@nestjs/common`
 *    isn't installed yet (`npm install` hasn't run), or a monorepo's
 *    tsconfig doesn't resolve it. The checker still returns an alias
 *    symbol, but `checker.getAliasedSymbol` can't advance past it, and its
 *    only declaration is the import site itself (an `ImportSpecifier` /
 *    `ImportClause` / `NamespaceImport`) — i.e. the checker never actually
 *    found *anything* to compare against `@nestjs/common`, so classifying
 *    this as "resolved to something else" (`'mismatch'`) would be wrong:
 *    it would silently reject every real `@Controller`/`@Get`/... in the
 *    project and the CLI would report an empty, "clean" route table. See
 *    B2 in the Phase 1 review — this was the actual bug, verified: it's the
 *    opposite failure from the one the plan worried about (over-eager
 *    acceptance), and much worse for a CI tool. `'mismatch'` is reserved for
 *    the case the checker *did* find a declaration and it demonstrably is
 *    not the target module (a genuine same-name collision).
 *
 * Rather than silently discarding a plausibly-real decorator in either
 * `'unverified'` case, this module falls back to name-based matching. The
 * three-way `Provenance` result lets callers choose: default
 * (`strict: false`) accepts `'verified'` and `'unverified'`, rejecting only
 * confirmed `'mismatch'`; `strict: true` accepts only `'verified'`.
 *
 * Path extraction (`extractPaths`) is deliberately lazy — it only runs for
 * decorators a caller has already identified as `Controller` or an
 * HTTP-method decorator, not for every decorator on a node (`@UseGuards`,
 * `@ApiTags`, ...), which would otherwise carry a meaningless `paths: ['']`.
 */

import * as ts from 'typescript';
import type { HttpMethod } from './types.js';
import { checkProvenance, type Provenance } from './provenance.js';

/**
 * Decorator names @nestjs/common exports for HTTP route handlers, mapped to
 * `HttpMethod`.
 *
 * `Sse` (issue #8) registers a GET route exactly like `@Get()` — NestJS's own
 * `RouterExplorer` maps it to `RequestMethod.GET` — so a handler carrying
 * only `@Sse()` and no `@Get()` was, before this entry existed, entirely
 * invisible to route discovery (not a route-table gap alone: every
 * downstream check keyed off a discovered handler, like `documented-status-codes`
 * or the implicit-codes checks, silently never ran on it either). See
 * `success.ts`'s module doc for why the route is discovered but its implicit
 * success status is deliberately NOT asserted, mirroring the existing
 * `@Redirect()`/`@Res()` carve-outs — an SSE handler doesn't return a single
 * response the way a normal GET does.
 */
export const HTTP_METHOD_DECORATOR_NAMES: Record<string, HttpMethod> = {
  Get: 'GET',
  Post: 'POST',
  Put: 'PUT',
  Delete: 'DELETE',
  Patch: 'PATCH',
  Options: 'OPTIONS',
  Head: 'HEAD',
  All: 'ALL',
  Search: 'SEARCH',
  Sse: 'GET',
};

const DEFAULT_MODULE = '@nestjs/common';

// `Provenance`, `checkProvenance`, and the module-membership check they rely
// on now live in `provenance.ts` — Phase 2's `resolve-status.ts` needs the
// identical strategy for non-decorator expressions (a thrown exception's
// `new X(...)` callee, an `HttpStatus.X` member access), so it was extracted
// rather than duplicated. Re-exported here so existing importers of
// `decorators.ts`'s `Provenance` type keep working.
export type { Provenance };

/** A single decorator recognized on a class or method (path-agnostic; see `RoutePathInfo`). */
export interface DecoratorInfo {
  /** Decorator name as written at the use site, e.g. `'Controller'`, `'HttpGet'` for an alias. */
  name: string;
  node: ts.Decorator;
  provenance: Provenance;
  /**
   * The target module's own name for this export, when the checker could
   * determine one (see `ProvenanceResult.resolvedName`). Callers should
   * match against `resolvedName ?? name` so aliased imports still match.
   */
  resolvedName: string | undefined;
}

export interface RoutePathInfo {
  /**
   * Path argument(s). `['']` for a bare `@Get()` / `@Controller()`. Multiple
   * entries when the decorator was called with an array literal
   * (`@Get(['a', 'b'])`) — NestJS registers one route per array element.
   */
  paths: string[];
  /**
   * True if the path argument couldn't be fully resolved statically (e.g. a
   * template literal with an interpolation the checker also couldn't fold,
   * or an array containing such an element). `paths` still contains
   * whatever could be resolved; callers must surface this rather than
   * silently trusting `paths` as fact.
   */
  unresolvedPath: boolean;
}

export interface ControllerInfo extends RoutePathInfo {
  node: ts.Decorator;
}

export interface HttpHandlerDecoratorInfo extends RoutePathInfo {
  node: ts.Decorator;
  decoratorName: string;
  httpMethod: HttpMethod;
}

/**
 * The callee of a decorator expression: `@Foo` → `Foo`, `@Foo(...)` → `Foo`.
 * Exported (CodeRabbit review on PR #4) so `success.ts`/`validation-pipe.ts`
 * — which need the same "what decorator is this, by name" logic for their
 * own implicit-status detection — share this implementation instead of each
 * keeping a byte-identical private copy that could silently drift.
 */
export function getDecoratorNameNode(decorator: ts.Decorator): ts.Expression {
  const expr = decorator.expression;
  return ts.isCallExpression(expr) ? expr.expression : expr;
}

function getDecoratorCallArgument(decorator: ts.Decorator): ts.Expression | undefined {
  const expr = decorator.expression;
  return ts.isCallExpression(expr) ? expr.arguments[0] : undefined;
}

/** See `getDecoratorNameNode`'s doc comment — shared for the same reason. */
export function getDecoratorName(nameNode: ts.Expression): string | undefined {
  if (ts.isIdentifier(nameNode)) return nameNode.text;
  if (ts.isPropertyAccessExpression(nameNode) && ts.isIdentifier(nameNode.name))
    return nameNode.name.text;
  return undefined;
}

/**
 * Resolves an expression to a literal string value where statically
 * possible. Beyond plain string literals, this folds:
 *
 * - `'a' + 'b'` — binary `+` of two resolvable string operands.
 * - `const X = 'x'` references and `'x' as const` — via
 *   `checker.getTypeAtLocation`, which reports a string-literal type for
 *   these. This is a best-effort bonus, not a full constant-folding
 *   evaluator: dynamic values (a plain `let`, a function call, an
 *   interpolated template literal whose parts aren't all literal-typed)
 *   correctly fall through to `undefined`.
 */
function resolveToStringLiteral(expr: ts.Expression, checker: ts.TypeChecker): string | undefined {
  if (ts.isStringLiteralLike(expr)) return expr.text;

  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = resolveToStringLiteral(expr.left, checker);
    const right = resolveToStringLiteral(expr.right, checker);
    return left !== undefined && right !== undefined ? left + right : undefined;
  }

  try {
    const type = checker.getTypeAtLocation(expr);
    if (type.isStringLiteral()) return type.value;
  } catch {
    // fall through to unresolved
  }
  return undefined;
}

/**
 * Resolves a decorator's path argument into zero-or-more literal path
 * segments. Handles: no argument, a resolvable string expression (see
 * `resolveToStringLiteral`), an array literal (possibly mixed with
 * unresolvable elements), and an object literal with a `path` property
 * (`@Controller({ path: 'x' })`). Anything else (a non-literal expression
 * the resolver can't fold, a spread, ...) is reported via
 * `unresolvedPath: true` with `paths: ['']` as a safe default.
 */
function extractPaths(expr: ts.Expression | undefined, checker: ts.TypeChecker): RoutePathInfo {
  if (!expr) return { paths: [''], unresolvedPath: false };

  if (ts.isArrayLiteralExpression(expr)) {
    const paths: string[] = [];
    let unresolvedPath = false;
    for (const el of expr.elements) {
      const value = resolveToStringLiteral(el, checker);
      if (value === undefined) {
        unresolvedPath = true;
      } else {
        paths.push(value);
      }
    }
    if (paths.length === 0) return { paths: [''], unresolvedPath: true };
    return { paths, unresolvedPath };
  }

  if (ts.isObjectLiteralExpression(expr)) {
    for (const prop of expr.properties) {
      if (
        ts.isPropertyAssignment(prop) &&
        ((ts.isIdentifier(prop.name) && prop.name.text === 'path') ||
          (ts.isStringLiteral(prop.name) && prop.name.text === 'path'))
      ) {
        return extractPaths(prop.initializer, checker);
      }
    }
    // No `path` property (e.g. `@Controller({ version: '1' })`) — default.
    return { paths: [''], unresolvedPath: false };
  }

  const literal = resolveToStringLiteral(expr, checker);
  if (literal !== undefined) return { paths: [literal], unresolvedPath: false };
  return { paths: [''], unresolvedPath: true };
}

/** Reads and classifies every decorator on a class/method declaration (no path extraction — see module doc). */
export function getDecoratorInfos(
  node: ts.ClassLikeDeclaration | ts.MethodDeclaration,
  checker: ts.TypeChecker,
  moduleName: string = DEFAULT_MODULE,
): DecoratorInfo[] {
  if (!ts.canHaveDecorators(node)) return [];
  const decorators = ts.getDecorators(node);
  if (!decorators || decorators.length === 0) return [];

  const infos: DecoratorInfo[] = [];
  for (const decorator of decorators) {
    const nameNode = getDecoratorNameNode(decorator);
    const name = getDecoratorName(nameNode);
    if (name === undefined) continue;
    const { provenance, resolvedName } = checkProvenance(nameNode, checker, moduleName);
    infos.push({ name, node: decorator, provenance, resolvedName });
  }
  return infos;
}

function isAccepted(provenance: Provenance, strict: boolean): boolean {
  if (provenance === 'mismatch') return false;
  if (strict) return provenance === 'verified';
  return true;
}

function effectiveName(d: DecoratorInfo): string {
  return d.resolvedName ?? d.name;
}

/**
 * Returns this class's `@Controller(...)` info, or `undefined` if the class
 * has no (accepted) `@Controller` decorator — i.e. it is not a controller.
 */
export function getControllerInfo(
  classNode: ts.ClassLikeDeclaration,
  checker: ts.TypeChecker,
  strict = false,
): ControllerInfo | undefined {
  const decorators = getDecoratorInfos(classNode, checker);
  const controller = decorators.find(
    (d) => effectiveName(d) === 'Controller' && isAccepted(d.provenance, strict),
  );
  if (!controller) return undefined;
  const { paths, unresolvedPath } = extractPaths(
    getDecoratorCallArgument(controller.node),
    checker,
  );
  return { node: controller.node, paths, unresolvedPath };
}

/**
 * Returns every accepted HTTP-method decorator on a method. A method with
 * multiple HTTP decorators (`@Get()` and `@Post()` on the same method) yields
 * multiple entries — see `handlers.ts` for the consequence on `HandlerInfo`.
 */
export function getHttpHandlerDecorators(
  methodNode: ts.MethodDeclaration,
  checker: ts.TypeChecker,
  strict = false,
): HttpHandlerDecoratorInfo[] {
  const decorators = getDecoratorInfos(methodNode, checker);
  const results: HttpHandlerDecoratorInfo[] = [];
  for (const d of decorators) {
    const httpMethod = HTTP_METHOD_DECORATOR_NAMES[effectiveName(d)];
    if (httpMethod === undefined) continue;
    if (!isAccepted(d.provenance, strict)) continue;
    const { paths, unresolvedPath } = extractPaths(getDecoratorCallArgument(d.node), checker);
    results.push({ node: d.node, decoratorName: d.name, httpMethod, paths, unresolvedPath });
  }
  return results;
}
