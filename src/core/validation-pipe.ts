/**
 * The implicit `400` a handler can produce via `ValidationPipe` rejecting a
 * `class-validator`-decorated DTO parameter (PLAN §4.1c, opt-in — see
 * `types.ts`'s doc comment on `AnalysisOptions.checkValidationPipe` for why
 * this stays off by default).
 *
 * Detection, deliberately narrow (silence over noise — a false "this DTO is
 * validated" is worse than missing a real one):
 *
 * 1. The handler has a parameter decorated with `@Body()`, `@Param()`, or
 *    `@Query()` from `@nestjs/common` — the three request-data decorators
 *    `ValidationPipe` actually intercepts (`@Headers()`/`@Req()`/... are not
 *    validated the same way and are deliberately excluded).
 * 2. That parameter's static type resolves to a `class` declaration (not an
 *    interface, not a primitive/union/inline object type — `class-validator`
 *    decorators can only ever be attached to a class's own members, so
 *    anything else structurally cannot carry them). An array-typed parameter
 *    (`@Body() items: CreateItemDto[]`, issue #13a) is unwrapped to its
 *    element type first — `ValidationPipe` validates (and rejects) each array
 *    element the same way it validates a single DTO, so `CreateItemDto[]` is
 *    just as much an implicit-400 source as `CreateItemDto` alone; without
 *    the unwrap, `type.getSymbol()` on an array type resolves to `Array`'s
 *    own symbol (not a `ClassDeclaration` at all), silently missing every
 *    array-of-DTO parameter.
 * 3. At least one of that class's own property declarations carries a
 *    decorator whose provenance isn't a confirmed `class-validator` mismatch
 *    (the same "accept verified-or-unverified, reject only a demonstrated
 *    same-name collision" posture every other provenance check in this
 *    project uses — see `provenance.ts`'s module doc), OR is a LOCALLY
 *    composed decorator (`applyDecorators(IsString(), MinLength(8))`, issue
 *    #13b) whose own body calls a real `class-validator` export somewhere
 *    inside it — mirroring `guard-narrowing.ts`'s `collectMetadataKeys`,
 *    which resolves a decorator factory's OWN declaration and walks its body
 *    for a call to the thing that actually matters (there, `SetMetadata`;
 *    here, any `class-validator` decorator), rather than trusting a single
 *    level of provenance on the property decorator itself — a
 *    locally-declared composed decorator is, by construction, never going to
 *    resolve as `class-validator`'s own export, so the naive one-level check
 *    silently treated every DTO using this common pattern as unvalidated.
 *    Inherited validator decorators on a DTO base class are NOT walked (a
 *    Phase 5 scope decision, not an oversight): unlike `documented.ts`'s
 *    class-`extends` walk (justified by `@nestjs/swagger`'s own
 *    `Reflect.getMetadata` behavior), there's no equivalently strong reason
 *    to assume a DTO base class's decorators are what's driving THIS
 *    validation, and widening the search only widens the guess.
 */

import * as ts from 'typescript';
import type { StatusSource } from './types.js';
import { checkProvenance } from './provenance.js';
import { getDecoratorName, getDecoratorNameNode } from './decorators.js';
import { resolveAliasedSymbol } from './heritage.js';

const NEST_COMMON_MODULE = '@nestjs/common';
const CLASS_VALIDATOR_MODULE = 'class-validator';
export const BODY_LIKE_DECORATOR_NAMES: ReadonlySet<string> = new Set(['Body', 'Param', 'Query']);

/** `true` if `param` carries an accepted `@Body()`/`@Param()`/`@Query()` decorator. */
export function hasBodyLikeDecorator(param: ts.ParameterDeclaration, checker: ts.TypeChecker): boolean {
  if (!ts.canHaveDecorators(param)) return false;
  const decorators = ts.getDecorators(param);
  if (!decorators) return false;
  for (const decorator of decorators) {
    const nameNode = getDecoratorNameNode(decorator);
    const name = getDecoratorName(nameNode);
    if (name === undefined || !BODY_LIKE_DECORATOR_NAMES.has(name)) continue;
    const { provenance } = checkProvenance(nameNode, checker, NEST_COMMON_MODULE);
    if (provenance !== 'mismatch') return true;
  }
  return false;
}

/**
 * Resolves `param`'s static type to the class declaration it names, when
 * it's a plain class reference OR an array of one (issue #13a). An
 * array-typed parameter is unwrapped to its element type BEFORE falling back
 * to `type.getSymbol()` — called directly on the array type itself,
 * `getSymbol()` resolves to `Array`'s own symbol (which has no
 * `ClassDeclaration` among its declarations), not the element type's, so
 * without the unwrap every `@Body() items: CreateItemDto[]`-shaped parameter
 * silently fails step 2 and is never considered for the implicit 400. The
 * public `TypeChecker` API has no direct `getElementTypeOfArrayType`, so this
 * uses the public equivalent: `isArrayType` to confirm the shape, then
 * `getTypeArguments` on the resulting `TypeReference` to pull out the single
 * element type argument.
 */
function resolveParameterClassDeclaration(
  param: ts.ParameterDeclaration,
  checker: ts.TypeChecker,
): ts.ClassDeclaration | undefined {
  let type: ts.Type;
  try {
    type = checker.getTypeAtLocation(param);
  } catch {
    return undefined;
  }
  if (checker.isArrayType(type)) {
    const [elementType] = checker.getTypeArguments(type as ts.TypeReference);
    if (elementType) type = elementType;
  }
  const symbol = type.getSymbol();
  return symbol?.getDeclarations()?.find(ts.isClassDeclaration);
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

function safeSymbol(checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined {
  try {
    return checker.getSymbolAtLocation(node);
  } catch {
    return undefined;
  }
}

/**
 * `true` if `node`'s subtree contains a call to a `class-validator` export
 * (`IsString()`, `MinLength(8)`, ...) — checked directly, OR by recursing
 * into ANOTHER locally-resolvable decorator factory it calls (issue #13b's
 * `applyDecorators(IsString(), MinLength(8))` shape). Mirrors
 * `guard-narrowing.ts`'s `collectMetadataKeys` (same bounded
 * `MAX_FACTORY_RESOLUTION_DEPTH` / `seen`-set posture, same reason: a
 * locally-declared composed decorator's OWN provenance can never resolve to
 * `class-validator` — only what it calls can — so this has to look inside
 * the factory's body rather than stopping at a single-level provenance check
 * on the property decorator itself). Scoped to genuine factory shapes only
 * (`functionLikeBodyOf`), never recursing into a class or ambient signature.
 */
function callsClassValidator(
  node: ts.Node,
  checker: ts.TypeChecker,
  seen: Set<ts.Declaration>,
  depth: number,
): boolean {
  if (depth > MAX_FACTORY_RESOLUTION_DEPTH) return false;
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    const name = getDecoratorName(callee);
    if (name !== undefined) {
      const { provenance } = checkProvenance(callee, checker, CLASS_VALIDATOR_MODULE);
      if (provenance !== 'mismatch') return true;
    }
    const rawSym = safeSymbol(checker, callee);
    const sym = rawSym ? resolveAliasedSymbol(rawSym, checker) : undefined;
    for (const decl of sym?.getDeclarations() ?? []) {
      if (seen.has(decl)) continue;
      const body = functionLikeBodyOf(decl);
      if (!body) continue;
      seen.add(decl);
      if (callsClassValidator(body, checker, seen, depth + 1)) return true;
    }
  }
  let found = false;
  ts.forEachChild(node, (child) => {
    if (!found && callsClassValidator(child, checker, seen, depth)) found = true;
  });
  return found;
}

/**
 * `true` if any of `classDecl`'s own property members carries a
 * `class-validator` decorator — directly (provenance resolves straight to
 * `class-validator`), or indirectly via a locally-composed decorator factory
 * whose own body calls one (issue #13b, see `callsClassValidator`).
 */
function hasClassValidatorDecorator(classDecl: ts.ClassDeclaration, checker: ts.TypeChecker): boolean {
  for (const member of classDecl.members) {
    if (!ts.isPropertyDeclaration(member) || !ts.canHaveDecorators(member)) continue;
    const decorators = ts.getDecorators(member);
    if (!decorators) continue;
    for (const decorator of decorators) {
      const nameNode = getDecoratorNameNode(decorator);
      if (getDecoratorName(nameNode) === undefined) continue;
      const { provenance } = checkProvenance(nameNode, checker, CLASS_VALIDATOR_MODULE);
      if (provenance !== 'mismatch') return true;

      // Issue #13b: a locally-composed decorator (`applyDecorators(IsString(), ...)`)
      // has its OWN provenance resolve as `'mismatch'` (it's declared in-app,
      // not in `class-validator`) — walk into its declaration's body looking
      // for a call to a real `class-validator` export before giving up.
      const rawSym = safeSymbol(checker, nameNode);
      const sym = rawSym ? resolveAliasedSymbol(rawSym, checker) : undefined;
      for (const decl of sym?.getDeclarations() ?? []) {
        const body = functionLikeBodyOf(decl);
        if (!body) continue;
        if (callsClassValidator(body, checker, new Set([decl]), 0)) return true;
      }
    }
  }
  return false;
}

/**
 * Collects the implicit `400` `methodNode` can produce via `ValidationPipe`,
 * when `AnalysisOptions.checkValidationPipe` is enabled — a single
 * `StatusSource` naming every qualifying DTO parameter found (usually one),
 * or `undefined` if none qualify.
 */
export function collectValidationPipeSource(
  methodNode: ts.MethodDeclaration,
  checker: ts.TypeChecker,
): StatusSource | undefined {
  const dtoNames: string[] = [];

  for (const param of methodNode.parameters) {
    if (!hasBodyLikeDecorator(param, checker)) continue;
    const classDecl = resolveParameterClassDeclaration(param, checker);
    if (!classDecl?.name) continue;
    if (!hasClassValidatorDecorator(classDecl, checker)) continue;
    dtoNames.push(classDecl.name.text);
  }

  if (dtoNames.length === 0) return undefined;
  return {
    kind: 'implicit',
    reason: 'validation-pipe',
    node: methodNode,
    detail: dtoNames.join(', '),
  };
}
