/**
 * The implicit `400` (or, for `errorHttpStatusCode`-overridden pipes, whatever
 * other status the pipe actually throws — issue #17 rework) a handler can
 * produce via one of NestJS's built-in transformation pipes (`ParseIntPipe`,
 * `ParseUUIDPipe`, `ParseBoolPipe`, `ParseEnumPipe`, `ParseFloatPipe`,
 * `ParseArrayPipe`, `ParseFilePipe`) applied to a request-data parameter
 * decorator (opt-in — see `types.ts`'s doc comment on
 * `AnalysisOptions.checkParsePipes` for why this stays off by default,
 * mirroring `checkValidationPipe`).
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
 * 1. The handler has a parameter decorated with `@Body()`, `@Param()`,
 *    `@Query()`, `@Headers()`, `@UploadedFile()`, or `@UploadedFiles()` from
 *    `@nestjs/common` (`PARSE_PIPE_DECORATOR_NAMES` below) — deliberately a
 *    WIDER set than `validation-pipe.ts`'s `BODY_LIKE_DECORATOR_NAMES`
 *    (adversarial review): that set's Body/Param/Query-only scope is
 *    justified there by what a *global* `ValidationPipe` implicitly
 *    intercepts, a justification that does not transfer to an EXPLICITLY
 *    attached pipe — `@Headers('x-count', ParseIntPipe)` and
 *    `@UploadedFile(new ParseFilePipe({...}))` both run their pipe exactly
 *    the same way NestJS runs one on `@Param`/`@Query`/`@Body`, and
 *    `ParseFilePipe` specifically is canonically attached via
 *    `@UploadedFile()`/`@UploadedFiles()` — under the old Body/Param/Query-only
 *    gate it could never be reached at all, despite being advertised as
 *    supported.
 * 2. That SAME decorator's call carries one (or more — ALL are collected, not
 *    just the first, issue #17 adversarial review) of the built-in
 *    `Parse*Pipe` classes among its arguments — as a bare class reference
 *    (`@Param('id', ParseIntPipe)`), an instantiation
 *    (`@Param('id', new ParseIntPipe())`), or inside an array literal of
 *    pipes (`@Query('page', [ParseIntPipe])`) — recognized regardless of
 *    which argument position it appears in, since NestJS itself accepts the
 *    property-name argument as optional (`@Param(ParseIntPipe)` is valid).
 * 3. The identified class's provenance isn't a confirmed mismatch against
 *    `@nestjs/common` (the same "verified-or-unverified, reject only a
 *    demonstrated same-name collision" posture every other provenance check
 *    in this project uses).
 *
 * ## `errorHttpStatusCode` (issue #17)
 *
 * Every built-in `Parse*Pipe` accepts an options object whose
 * `errorHttpStatusCode` overrides the status it throws — NestJS's own docs
 * show `new ParseIntPipe({ errorHttpStatusCode: HttpStatus.NOT_ACCEPTABLE })`
 * throwing `406`, not `400`. Reporting a flat `400` for every `Parse*Pipe`
 * usage was worse than merely incomplete: it actively told the user to
 * document a status the handler can never produce. When a `new
 * Parse*Pipe(...)` instantiation has an object-literal argument (searched
 * across ALL argument positions, not just `arguments[0]` — `ParseEnumPipe`'s
 * constructor is `(enumType, options?)`, so its options object sits at
 * `arguments[1]`; adversarial review) with an `errorHttpStatusCode` property
 * (by identifier, string-literal, OR shorthand name — `{ errorHttpStatusCode
 * }` is the realistic case for a shared repo-wide default), its value is
 * resolved via `resolveStatusExpression` (the same literal/`HttpStatus`-member
 * resolution `success.ts`/`resolve-status.ts` use) and that status is
 * reported instead of `400`. Per "silence over noise": if `errorHttpStatusCode`
 * IS present but its value isn't statically resolvable, that pipe usage
 * contributes NOTHING (not a guessed `400`, which would be actively wrong the
 * same way ignoring the property entirely was) — mirrors `success.ts`'s
 * refusal to guess a dynamic `@HttpCode(...)` argument's status.
 *
 * `exceptionFactory` takes the same "contributes nothing" treatment
 * (adversarial review): NestJS's built-in pipes resolve the thrown exception
 * as `exceptionFactory ?? HttpErrorByCode[errorHttpStatusCode]`, so a pipe
 * usage naming a factory throws THAT factory's exception — never
 * `errorHttpStatusCode`'s status, even when both are present — and this tool
 * has no general way to resolve an arbitrary factory function's thrown
 * status. A `{ ...spread }`-composed options object (`new ParseIntPipe({
 * ...pipeDefaults })`) is NOT specifically modeled — its properties aren't
 * visible as literal `ObjectLiteralExpression` members at all — and still
 * falls back to the default `400`; a known, narrow gap, not silently
 * reintroducing the `errorHttpStatusCode`/`exceptionFactory` false positives
 * above.
 */

import * as ts from 'typescript';
import type { StatusSource } from './types.js';
import { checkProvenance, getExpressionName } from './provenance.js';
import { getDecoratorName, getDecoratorNameNode } from './decorators.js';
import { resolveStatusExpression } from './status-value.js';

const NEST_COMMON_MODULE = '@nestjs/common';
const DEFAULT_PARSE_PIPE_STATUS = 400;

/**
 * The request-data parameter decorators an explicitly-attached pipe can run
 * behind — wider than `validation-pipe.ts`'s `BODY_LIKE_DECORATOR_NAMES` (see
 * module doc's `errorHttpStatusCode`/decorator-scope section for why that
 * set's justification doesn't transfer to this check).
 */
const PARSE_PIPE_DECORATOR_NAMES: ReadonlySet<string> = new Set([
  'Body',
  'Param',
  'Query',
  'Headers',
  'UploadedFile',
  'UploadedFiles',
]);

/** NestJS's built-in transformation pipes that throw on a coercion failure. */
const BUILTIN_PARSE_PIPE_NAMES: ReadonlySet<string> = new Set([
  'ParseBoolPipe',
  'ParseIntPipe',
  'ParseFloatPipe',
  'ParseEnumPipe',
  'ParseUUIDPipe',
  'ParseArrayPipe',
  'ParseFilePipe',
  // Issue #17 (adversarial review): missing entirely — same
  // `errorHttpStatusCode`/`exceptionFactory`-carrying options shape and the
  // same throw-on-failure behavior as every other built-in `Parse*Pipe`.
  'ParseDatePipe',
]);

/** `true` if `param` carries an accepted parse-pipe-hosting decorator (module doc, point 1). */
function hasParsePipeHostDecorator(param: ts.ParameterDeclaration, checker: ts.TypeChecker): boolean {
  if (!ts.canHaveDecorators(param)) return false;
  const decorators = ts.getDecorators(param);
  if (!decorators) return false;
  for (const decorator of decorators) {
    const nameNode = getDecoratorNameNode(decorator);
    const name = getDecoratorName(nameNode);
    if (name === undefined || !PARSE_PIPE_DECORATOR_NAMES.has(name)) continue;
    const { provenance } = checkProvenance(nameNode, checker, NEST_COMMON_MODULE);
    if (provenance !== 'mismatch') return true;
  }
  return false;
}

/**
 * A property name, however it's spelled — `ts.getDecorators`-adjacent code
 * elsewhere in this project (`decorators.ts`'s `path` handling) already
 * accepts an identifier OR a string-literal name; this does the same for
 * `PropertyAssignment.name`/`ShorthandPropertyAssignment.name` so
 * `new ParseIntPipe({ 'errorHttpStatusCode': 406 })` and
 * `new ParseIntPipe({ errorHttpStatusCode })` (a shared local const — the
 * realistic case, e.g. a repo-wide `errorHttpStatusCode` default) aren't
 * silently missed the way a bare `ts.isIdentifier` check would miss them
 * (issue #17, adversarial review).
 */
function propertyNameText(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return undefined;
}

/**
 * Resolves a `new Parse*Pipe({ ... })` instantiation's overridden status,
 * when statically possible. Object-literal options are looked for among ALL
 * of the `new` expression's arguments, not just `arguments[0]` (issue #17,
 * adversarial review): `ParseEnumPipe`'s constructor is
 * `(enumType, options?)` — the options object is `arguments[1]`, not
 * `arguments[0]` — so hard-coding index `0` produced a confirmed false
 * positive (a resolvable `errorHttpStatusCode` on `ParseEnumPipe` was
 * silently ignored and `400` guessed instead).
 *
 * Two outcomes are NOT "no override, default to `400`":
 * - `exceptionFactory` present: NestJS's own `Parse*Pipe`s use
 *   `exceptionFactory ?? HttpErrorByCode[errorHttpStatusCode]` — when a
 *   factory is given it wins outright, regardless of `errorHttpStatusCode`
 *   also being present. This tool cannot generally resolve an arbitrary
 *   factory function's thrown status, so a pipe usage naming one contributes
 *   NOTHING (silence over noise), not a guessed `400` (a confirmed false
 *   positive otherwise: `new ParseIntPipe({ exceptionFactory: () => new
 *   UnprocessableEntityException() })` throws `422`, never `400`).
 * - `errorHttpStatusCode` present but not statically resolvable: same
 *   "contribute nothing" rule as before this rework, just now reachable from
 *   any argument position.
 *
 * `undefined` when `expr` isn't a `NewExpression` or none of its arguments is
 * an object literal at all — "no override to consider," the caller's
 * signal to fall back to the default `400`.
 */
/**
 * Resolves a `ShorthandPropertyAssignment`'s value (`{ errorHttpStatusCode }`
 * — the value IS the name identifier, referencing some outer binding) to a
 * literal number, when possible. NOT simply `resolveStatusExpression(prop.name,
 * checker)`: the object literal here is contextually typed against the
 * pipe's `{ errorHttpStatusCode?: number }` options parameter, and the TS
 * checker widens a shorthand property's value type to match that CONTEXTUAL
 * type (`number`), discarding the referenced `const`'s own literal type —
 * confirmed empirically, and different from a `PropertyAssignment`'s
 * `initializer` (`{ errorHttpStatusCode: errorHttpStatusCode }`), which
 * keeps the literal fine. Instead, this resolves the shorthand's OWN
 * referenced symbol (`getShorthandAssignmentValueSymbol`) back to its
 * declaration and re-resolves that declaration's initializer directly,
 * sidestepping the contextual-typing narrowing loss entirely.
 */
function resolveShorthandValue(
  prop: ts.ShorthandPropertyAssignment,
  checker: ts.TypeChecker,
): number | undefined {
  const direct = resolveStatusExpression(prop.name, checker);
  if (direct !== undefined) return direct;
  const symbol = checker.getShorthandAssignmentValueSymbol(prop);
  for (const decl of symbol?.getDeclarations() ?? []) {
    if (ts.isVariableDeclaration(decl) && decl.initializer) {
      const resolved = resolveStatusExpression(decl.initializer, checker);
      if (resolved !== undefined) return resolved;
    }
  }
  return undefined;
}

function resolveErrorHttpStatusCode(
  expr: ts.Expression,
  checker: ts.TypeChecker,
): { present: true; status: number | undefined } | { present: false } {
  if (!ts.isNewExpression(expr) || !expr.arguments) return { present: false };

  for (const arg of expr.arguments) {
    if (!ts.isObjectLiteralExpression(arg)) continue;

    let hasExceptionFactory = false;
    let status: number | undefined;
    let statusPresent = false;
    for (const prop of arg.properties) {
      // A `ShorthandPropertyAssignment` (`{ errorHttpStatusCode }`, `{
      // exceptionFactory }`) has no separate `initializer` — see
      // `resolveShorthandValue` for why it needs its own resolution path.
      if (ts.isShorthandPropertyAssignment(prop)) {
        if (prop.name.text === 'exceptionFactory') hasExceptionFactory = true;
        else if (prop.name.text === 'errorHttpStatusCode') {
          statusPresent = true;
          status = resolveShorthandValue(prop, checker);
        }
        continue;
      }
      if (!ts.isPropertyAssignment(prop)) continue;
      const name = propertyNameText(prop.name);
      if (name === 'exceptionFactory') {
        hasExceptionFactory = true;
      } else if (name === 'errorHttpStatusCode') {
        statusPresent = true;
        status = resolveStatusExpression(prop.initializer, checker);
      }
    }

    if (hasExceptionFactory) return { present: true, status: undefined };
    if (statusPresent) return { present: true, status };
  }

  return { present: false };
}

interface ParsePipeUsage {
  name: string;
  /** `undefined` only when `errorHttpStatusCode` was present but unresolvable — caller must skip, not guess `400`. */
  status: number | undefined;
}

/**
 * Resolves `expr` to every built-in `Parse*Pipe` usage it names, when
 * statically possible — a bare class reference, a `new X(...)` instantiation
 * (carrying its own possibly-overridden status), or (given an array literal,
 * e.g. a `pipes: [...]` argument) every such reference found among its
 * elements. Collects ALL matches rather than stopping at the first (issue
 * #17, adversarial review): a parameter can carry more than one `Parse*Pipe`
 * — `@Query('n', ParseIntPipe, new ParseUUIDPipe({ errorHttpStatusCode: 422
 * }))` or `@Param('id', [new ParseUUIDPipe({ errorHttpStatusCode: 422 }),
 * ParseIntPipe])` — and stopping at the first found silently dropped every
 * status after it, despite `collectParsePipesSources` already being able to
 * group multiple distinct statuses per method.
 */
function findParsePipeUsages(expr: ts.Expression, checker: ts.TypeChecker): ParsePipeUsage[] {
  if (ts.isArrayLiteralExpression(expr)) {
    return expr.elements.flatMap((element) => findParsePipeUsages(element, checker));
  }

  const callee = ts.isNewExpression(expr) ? expr.expression : expr;
  const named = getExpressionName(callee);
  if (!named || !BUILTIN_PARSE_PIPE_NAMES.has(named.name)) return [];

  const { provenance, resolvedName } = checkProvenance(named.nameNode, checker, NEST_COMMON_MODULE);
  if (provenance === 'mismatch') return [];

  const override = resolveErrorHttpStatusCode(expr, checker);
  const status = override.present ? override.status : DEFAULT_PARSE_PIPE_STATUS;
  return [{ name: resolvedName ?? named.name, status }];
}

/** Every built-in `Parse*Pipe` usage named anywhere among `decorator`'s call arguments. */
function decoratorPipeUsages(decorator: ts.Decorator, checker: ts.TypeChecker): ParsePipeUsage[] {
  const expr = decorator.expression;
  if (!ts.isCallExpression(expr)) return [];
  return expr.arguments.flatMap((arg) => findParsePipeUsages(arg, checker));
}

/** One `StatusSource` per distinct status a method's `Parse*Pipe` usages can produce. */
export interface ParsePipeStatusSource {
  status: number;
  source: StatusSource;
}

/**
 * Collects the implicit status(es) `methodNode` can produce via NestJS's
 * built-in `Parse*Pipe`s, when `AnalysisOptions.checkParsePipes` is enabled —
 * grouped by status (usually just `400`, but an `errorHttpStatusCode`
 * override can make a method report a different or an ADDITIONAL status; see
 * module doc). Pipe names within a single status are de-duplicated (the same
 * `ParseIntPipe` attached to two different parameters shouldn't render
 * twice). Pipe usages whose `errorHttpStatusCode` was present but
 * unresolvable contribute nothing (silence over noise), not a guessed `400`.
 */
export function collectParsePipesSources(
  methodNode: ts.MethodDeclaration,
  checker: ts.TypeChecker,
): ParsePipeStatusSource[] {
  const namesByStatus = new Map<number, Set<string>>();

  for (const param of methodNode.parameters) {
    if (!hasParsePipeHostDecorator(param, checker)) continue;
    if (!ts.canHaveDecorators(param)) continue; // narrows the type for `ts.getDecorators` below
    const decorators = ts.getDecorators(param);
    if (!decorators) continue;
    for (const decorator of decorators) {
      const nameNode = getDecoratorNameNode(decorator);
      const name = getDecoratorName(nameNode);
      if (name === undefined || !PARSE_PIPE_DECORATOR_NAMES.has(name)) continue;
      const { provenance } = checkProvenance(nameNode, checker, NEST_COMMON_MODULE);
      if (provenance === 'mismatch') continue;

      for (const usage of decoratorPipeUsages(decorator, checker)) {
        if (usage.status === undefined) continue; // unresolvable errorHttpStatusCode/exceptionFactory: skip, don't guess
        const names = namesByStatus.get(usage.status);
        if (names) names.add(usage.name);
        else namesByStatus.set(usage.status, new Set([usage.name]));
      }
    }
  }

  return [...namesByStatus.entries()].map(([status, names]) => ({
    status,
    source: {
      kind: 'implicit',
      reason: 'parse-pipe',
      node: methodNode,
      detail: [...names].join(', '),
    },
  }));
}
