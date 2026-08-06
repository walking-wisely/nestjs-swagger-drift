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
 *    anything else structurally cannot carry them).
 * 3. At least one of that class's own property declarations carries a
 *    decorator whose provenance isn't a confirmed `class-validator` mismatch
 *    (the same "accept verified-or-unverified, reject only a demonstrated
 *    same-name collision" posture every other provenance check in this
 *    project uses — see `provenance.ts`'s module doc). Inherited validator
 *    decorators on a DTO base class are NOT walked (a Phase 5 scope
 *    decision, not an oversight): unlike `documented.ts`'s class-`extends`
 *    walk (justified by `@nestjs/swagger`'s own `Reflect.getMetadata`
 *    behavior), there's no equivalently strong reason to assume a DTO base
 *    class's decorators are what's driving THIS validation, and widening the
 *    search only widens the guess.
 */

import * as ts from 'typescript';
import type { StatusSource } from './types.js';
import { checkProvenance } from './provenance.js';

const NEST_COMMON_MODULE = '@nestjs/common';
const CLASS_VALIDATOR_MODULE = 'class-validator';
const BODY_LIKE_DECORATOR_NAMES: ReadonlySet<string> = new Set(['Body', 'Param', 'Query']);

function getDecoratorNameNode(decorator: ts.Decorator): ts.Expression {
  const expr = decorator.expression;
  return ts.isCallExpression(expr) ? expr.expression : expr;
}

function getDecoratorName(nameNode: ts.Expression): string | undefined {
  if (ts.isIdentifier(nameNode)) return nameNode.text;
  if (ts.isPropertyAccessExpression(nameNode) && ts.isIdentifier(nameNode.name)) {
    return nameNode.name.text;
  }
  return undefined;
}

/** `true` if `param` carries an accepted `@Body()`/`@Param()`/`@Query()` decorator. */
function hasBodyLikeDecorator(param: ts.ParameterDeclaration, checker: ts.TypeChecker): boolean {
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

/** Resolves `param`'s static type to the class declaration it names, when it's a plain class reference. */
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
  const symbol = type.getSymbol();
  return symbol?.getDeclarations()?.find(ts.isClassDeclaration);
}

/** `true` if any of `classDecl`'s own property members carries a `class-validator` decorator. */
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
