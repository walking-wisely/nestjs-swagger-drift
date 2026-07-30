/**
 * Given a class (or a single method) and a type checker, produces the
 * `HandlerInfo[]` for its HTTP handler(s) — empty if the class isn't a
 * `@Controller`, or the method isn't a recognized HTTP handler.
 *
 * PLAN.md §2.1: the unit of analysis is one handler. `getHandlerInfosForMethod`
 * is the primitive that matches the plan's `analyzeHandler(method, ctx)`
 * shape directly — an ESLint rule listening on `MethodDefinition` can call it
 * with just the method node it already has, without climbing to the parent
 * class or re-scanning siblings. `getHandlersForClass` (the CLI's shape) is
 * built on top of it.
 *
 * Known gap (flagged for PLAN.md §6, not implemented here): NestJS ≥8 walks
 * the *whole prototype chain* when registering routes, so a handler declared
 * on a base class (`class Derived extends Base` where `Base` has `@Get(...)`)
 * is a live route NestJS will serve, even though it's not a member of
 * `Derived`'s own `ClassLikeDeclaration.members`. This module only looks at
 * a class's own members — inherited handlers are silently missed, which in
 * Phase 2+ becomes silent under-reporting of drift on any project using a
 * generic CRUD base controller (a common NestJS pattern). Fixing this needs
 * walking `heritageClauses` to the base class declaration (when it's in the
 * same program) and isn't attempted in Phase 1.
 */

import * as ts from 'typescript';
import type { HandlerInfo } from './types.js';
import { getControllerInfo, getHttpHandlerDecorators } from './decorators.js';
import { joinPath } from './routes.js';

export interface HandlerDiscoveryOptions {
  checker: ts.TypeChecker;
  /**
   * When `true`, only accept routing decorators the type checker can prove
   * resolve to a symbol declared in `@nestjs/common`; when `false` (default)
   * also accept decorators the checker can't resolve at all, matching by
   * name instead (see `decorators.ts`'s module doc for the full rationale).
   */
  strict?: boolean;
}

function getMemberName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteralLike(name)) return name.text;
  if (ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

function getClassName(classNode: ts.ClassLikeDeclaration): string {
  return classNode.name?.text ?? '<anonymous>';
}

function isStaticMethod(member: ts.MethodDeclaration): boolean {
  const modifiers = ts.canHaveModifiers(member) ? ts.getModifiers(member) : undefined;
  return modifiers?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword) ?? false;
}

/**
 * Produces `HandlerInfo[]` for `methodNode`, given the class it's a member
 * of (`methodNode.parent`). Empty if the parent isn't a class, the class
 * isn't a `@Controller`, the method is `static`/bodyless/private, or it
 * carries no accepted HTTP-method decorator.
 *
 * Skips (PLAN.md §5 Phase 1 review, S2): `static` methods (NestJS's
 * `MetadataScanner` walks the prototype, statics are never registered),
 * bodyless method signatures (overload signatures / ambient declarations —
 * NestJS routes only what actually runs), and `#private` methods (never
 * reachable as a route handler).
 */
export function getHandlerInfosForMethod(
  methodNode: ts.MethodDeclaration,
  options: HandlerDiscoveryOptions,
): HandlerInfo[] {
  const parent: ts.Node | undefined = methodNode.parent;
  if (parent === undefined || !ts.isClassLike(parent)) return [];
  if (isStaticMethod(methodNode)) return [];
  if (methodNode.body === undefined) return [];
  if (ts.isPrivateIdentifier(methodNode.name)) return [];

  const methodName = getMemberName(methodNode.name);
  if (methodName === undefined) return [];

  const { checker, strict = false } = options;
  const controller = getControllerInfo(parent, checker, strict);
  if (!controller) return [];

  const className = getClassName(parent);
  const httpDecorators = getHttpHandlerDecorators(methodNode, checker, strict);
  const handlers: HandlerInfo[] = [];

  for (const decorator of httpDecorators) {
    for (const classPath of controller.paths) {
      for (const methodPath of decorator.paths) {
        handlers.push({
          className,
          methodName,
          httpMethod: decorator.httpMethod,
          classPath,
          methodPath,
          path: joinPath(classPath, methodPath),
          unresolvedPath: controller.unresolvedPath || decorator.unresolvedPath,
          node: methodNode,
        });
      }
    }
  }

  return handlers;
}

/**
 * Produces `HandlerInfo[]` for every HTTP handler on `classNode`.
 *
 * A method decorated with more than one HTTP-method decorator (e.g.
 * `@Get()` and `@Post()` on the same method) yields one `HandlerInfo` per
 * decorator — `HandlerInfo` has no field to carry "multiple methods", and
 * NestJS itself registers each as an independent route, so this is the only
 * shape consistent with the existing type. Likewise, an array-form path
 * (`@Get(['a', 'b'])` or `@Controller(['a', 'b'])`) yields one `HandlerInfo`
 * per resolved path, and combinations multiply (2 class paths × 2 method
 * paths → 4 handlers) since that's what NestJS actually registers.
 */
export function getHandlersForClass(
  classNode: ts.ClassLikeDeclaration,
  options: HandlerDiscoveryOptions,
): HandlerInfo[] {
  const handlers: HandlerInfo[] = [];
  for (const member of classNode.members) {
    if (!ts.isMethodDeclaration(member)) continue;
    handlers.push(...getHandlerInfosForMethod(member, options));
  }
  return handlers;
}
