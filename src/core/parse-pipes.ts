/**
 * The implicit `400` a handler can produce via one of NestJS's built-in
 * transformation pipes (`ParseIntPipe`, `ParseUUIDPipe`, `ParseBoolPipe`,
 * `ParseEnumPipe`, `ParseFloatPipe`, `ParseArrayPipe`, `ParseFilePipe`)
 * applied to a `@Param()`/`@Query()`/`@Body()` parameter (issue #17, opt-in
 * — see `types.ts`'s doc comment on `AnalysisOptions.checkParsePipes` for why
 * this stays off by default, mirroring `checkValidationPipe`).
 *
 * These pipes throw a `BadRequestException` (`400`) when the raw request
 * value can't be coerced to the target type — e.g. `ParseIntPipe` on a
 * non-numeric `:id` segment — the exact same "implicit, decorator-driven
 * 400" shape `validation-pipe.ts` already models for a `class-validator`
 * DTO, just triggered by a built-in pipe class instead of a DTO's own
 * decorators.
 *
 * Detection, deliberately narrow (same "silence over noise" posture as
 * `validation-pipe.ts` — this tool cannot prove a pipe genuinely runs any
 * more than it can prove `ValidationPipe` is registered, only that the
 * decorator call names one):
 *
 * 1. The handler has a parameter decorated with `@Body()`, `@Param()`, or
 *    `@Query()` from `@nestjs/common` — shared with `validation-pipe.ts`
 *    (`hasBodyLikeDecorator`/`BODY_LIKE_DECORATOR_NAMES`), the exact same
 *    three request-data decorators a pipe can be attached to.
 * 2. That SAME decorator's call carries one of the built-in `Parse*Pipe`
 *    classes among its arguments — as a bare class reference
 *    (`@Param('id', ParseIntPipe)`), an instantiation
 *    (`@Param('id', new ParseIntPipe())`), or inside an array literal of
 *    pipes (`@Query('page', [ParseIntPipe])`) — recognized regardless of
 *    which argument position it appears in, since NestJS itself accepts the
 *    property-name argument as optional (`@Param(ParseIntPipe)` is valid).
 * 3. The identified class's provenance isn't a confirmed mismatch against
 *    `@nestjs/common` (the same "verified-or-unverified, reject only a
 *    demonstrated same-name collision" posture every other provenance check
 *    in this project uses).
 */

import * as ts from 'typescript';
import type { StatusSource } from './types.js';
import { checkProvenance, getExpressionName } from './provenance.js';
import { getDecoratorName, getDecoratorNameNode } from './decorators.js';
import { BODY_LIKE_DECORATOR_NAMES, hasBodyLikeDecorator } from './validation-pipe.js';

const NEST_COMMON_MODULE = '@nestjs/common';

/** NestJS's built-in transformation pipes that throw a `400` on a coercion failure. */
const BUILTIN_PARSE_PIPE_NAMES: ReadonlySet<string> = new Set([
  'ParseBoolPipe',
  'ParseIntPipe',
  'ParseFloatPipe',
  'ParseEnumPipe',
  'ParseUUIDPipe',
  'ParseArrayPipe',
  'ParseFilePipe',
]);

/**
 * Resolves `expr` to a built-in `Parse*Pipe` class name, when statically
 * possible — a bare class reference, a `new X(...)` instantiation, or (given
 * an array literal, e.g. a `pipes: [...]` argument) the first such reference
 * found among its elements.
 */
function findParsePipeClassName(expr: ts.Expression, checker: ts.TypeChecker): string | undefined {
  if (ts.isArrayLiteralExpression(expr)) {
    for (const element of expr.elements) {
      const found = findParsePipeClassName(element, checker);
      if (found) return found;
    }
    return undefined;
  }

  const callee = ts.isNewExpression(expr) ? expr.expression : expr;
  const named = getExpressionName(callee);
  if (!named || !BUILTIN_PARSE_PIPE_NAMES.has(named.name)) return undefined;

  const { provenance, resolvedName } = checkProvenance(named.nameNode, checker, NEST_COMMON_MODULE);
  if (provenance === 'mismatch') return undefined;
  return resolvedName ?? named.name;
}

/** The first built-in `Parse*Pipe` class named anywhere among `decorator`'s call arguments, if any. */
function decoratorPipeClassName(decorator: ts.Decorator, checker: ts.TypeChecker): string | undefined {
  const expr = decorator.expression;
  if (!ts.isCallExpression(expr)) return undefined;
  for (const arg of expr.arguments) {
    const found = findParsePipeClassName(arg, checker);
    if (found) return found;
  }
  return undefined;
}

/**
 * Collects the implicit `400` `methodNode` can produce via one of NestJS's
 * built-in `Parse*Pipe`s, when `AnalysisOptions.checkParsePipes` is enabled
 * — a single `StatusSource` naming every qualifying pipe found (usually
 * one), or `undefined` if none qualify.
 */
export function collectParsePipesSource(
  methodNode: ts.MethodDeclaration,
  checker: ts.TypeChecker,
): StatusSource | undefined {
  const pipeNames: string[] = [];

  for (const param of methodNode.parameters) {
    if (!hasBodyLikeDecorator(param, checker)) continue;
    if (!ts.canHaveDecorators(param)) continue; // narrows the type for `ts.getDecorators` below
    const decorators = ts.getDecorators(param);
    if (!decorators) continue;
    for (const decorator of decorators) {
      const nameNode = getDecoratorNameNode(decorator);
      const name = getDecoratorName(nameNode);
      if (name === undefined || !BODY_LIKE_DECORATOR_NAMES.has(name)) continue;
      const { provenance } = checkProvenance(nameNode, checker, NEST_COMMON_MODULE);
      if (provenance === 'mismatch') continue;

      const pipeName = decoratorPipeClassName(decorator, checker);
      if (pipeName) pipeNames.push(pipeName);
    }
  }

  if (pipeNames.length === 0) return undefined;
  return {
    kind: 'implicit',
    reason: 'parse-pipe',
    node: methodNode,
    detail: pipeNames.join(', '),
  };
}
