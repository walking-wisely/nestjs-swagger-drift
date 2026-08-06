/**
 * The implicit 2xx success status a handler produces when it returns
 * normally (PLAN §4.1c, on by default — see `types.ts`'s doc comment on
 * `AnalysisOptions.checkSuccessResponse` for why this one check, alone among
 * Phase 5's implicit codes, isn't opt-in).
 *
 * NestJS's default (`@nestjs/common`'s `RouterExecutionContext`) is `200` for
 * every HTTP method except `POST`, which defaults to `201` — mirrored here
 * without needing the real package (same "hand-maintained, drift-tested"
 * posture as `nest-exceptions.ts`, except this mapping is small enough, and
 * tied closely enough to `HttpMethod` rather than to an exported table, that
 * a runtime-verification test isn't worth its own module — a plain unit
 * test pinning the two cases is enough). `@HttpCode(n)`, when present,
 * overrides the default for every method, `POST` included.
 *
 * ## Where this default is deliberately NOT asserted (Phase 5 review, finding #4)
 *
 * The plain `200`/`201` default is a genuine guess unless NestJS's own
 * routing actually applies it, and there are two real handler shapes where
 * it doesn't:
 *
 * - `@Redirect(...)` — NestJS defaults a redirecting handler's response to
 *   `302`, not `200`/`201`, and the real redirect status can also be
 *   overridden per-call by the handler's own return value
 *   (`{ url, statusCode }`), which this tool has no way to see. Detected and
 *   skipped entirely below, regardless of `@HttpCode` (an explicit
 *   `@HttpCode` on a `@Redirect`-ed handler is itself an edge case this tool
 *   isn't confident enough about to resolve either way).
 * - `@Res()`/`@Response()` (library-mode response injection) — once a
 *   handler takes the raw response object, NestJS's automatic status-setting
 *   is bypassed entirely (unless `{ passthrough: true }` is used, which this
 *   module doesn't attempt to distinguish — see below); the handler sets
 *   its own status via the injected object, invisible to static analysis.
 *   Detected and skipped below.
 * - `@All()` — the one HTTP-method shape whose real semantics (and
 *   therefore its real default status) are genuinely unknowable from the
 *   decorator alone: an `@All()` handler could behave like a `GET` or like a
 *   `POST` depending on the actual incoming request. Skipped below UNLESS an
 *   explicit `@HttpCode` says otherwise, since an explicit `@HttpCode` is a
 *   fact, not a guess.
 *
 * `@Res({ passthrough: true })` is a real exception to the `@Res()` gap
 * above (NestJS's automatic status-setting still applies in passthrough
 * mode), but this module doesn't special-case it: `passthrough` is itself an
 * options-object property that would need its own static resolution, and
 * getting that wrong in the accepting direction (treating a non-passthrough
 * `@Res()` as passthrough) is exactly the false positive this whole function
 * exists to avoid — silence over noise, per PLAN §4.2, wins over the extra
 * precision.
 */

import * as ts from 'typescript';
import type { HttpMethod } from './types.js';
import { getDecoratorInfos } from './decorators.js';
import { checkProvenance } from './provenance.js';
import { resolveStatusExpression } from './status-value.js';

const NEST_COMMON_MODULE = '@nestjs/common';
const RESPONSE_OBJECT_PARAM_NAMES: ReadonlySet<string> = new Set(['Res', 'Response']);

function defaultSuccessStatus(httpMethod: HttpMethod): number {
  return httpMethod === 'POST' ? 201 : 200;
}

function getDecoratorCallArgument(decorator: ts.Decorator): ts.Expression | undefined {
  const expr = decorator.expression;
  return ts.isCallExpression(expr) ? expr.arguments[0] : undefined;
}

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

/**
 * `true` if any of `methodNode`'s parameters carries an accepted `@Res()`/
 * `@Response()` from `@nestjs/common` — see module doc's `@Res()` gap.
 */
function hasResponseObjectParameter(methodNode: ts.MethodDeclaration, checker: ts.TypeChecker): boolean {
  for (const param of methodNode.parameters) {
    if (!ts.canHaveDecorators(param)) continue;
    const decorators = ts.getDecorators(param);
    if (!decorators) continue;
    for (const decorator of decorators) {
      const nameNode = getDecoratorNameNode(decorator);
      const name = getDecoratorName(nameNode);
      if (name === undefined || !RESPONSE_OBJECT_PARAM_NAMES.has(name)) continue;
      const { provenance } = checkProvenance(nameNode, checker, NEST_COMMON_MODULE);
      if (provenance !== 'mismatch') return true;
    }
  }
  return false;
}

/**
 * Resolves the status `methodNode` implicitly returns on success, for the
 * given `httpMethod` (per-`HandlerInfo`, not per-method-node — see
 * `analyze.ts`'s doc comment on why this is computed per handler rather than
 * folded into `collectProducibleStatuses`: a method carrying both `@Get()`
 * and `@Post()` has two different implicit defaults for the exact same
 * body).
 *
 * Returns `undefined` — silently, per PLAN §4.2's "silence over noise" —
 * when:
 *
 * - `methodNode` carries `@Redirect(...)` or a `@Res()`/`@Response()`
 *   parameter (module doc: NestJS's automatic status-setting doesn't apply
 *   the plain default here at all).
 * - `httpMethod` is `'ALL'` and there is no explicit `@HttpCode` (module doc:
 *   genuinely unknowable which default semantics apply).
 * - An `@HttpCode(...)` decorator IS present but its argument isn't a
 *   statically resolvable literal (a variable, a computed expression):
 *   assuming the plain default in that case would be actively wrong, since
 *   the decorator is proof the method does NOT necessarily use it, and
 *   guessing which literal it resolves to at runtime is exactly the kind of
 *   manufactured finding this project refuses to produce.
 */
export function resolveSuccessStatus(
  methodNode: ts.MethodDeclaration,
  httpMethod: HttpMethod,
  checker: ts.TypeChecker,
): { status: number; node: ts.Node } | undefined {
  const decorators = getDecoratorInfos(methodNode, checker, NEST_COMMON_MODULE);

  const redirect = decorators.find(
    (d) => d.provenance !== 'mismatch' && (d.resolvedName ?? d.name) === 'Redirect',
  );
  if (redirect) return undefined;

  if (hasResponseObjectParameter(methodNode, checker)) return undefined;

  // Provenance-checked (Phase 5 review, finding #9), matching `guards.ts`/
  // `validation-pipe.ts`'s posture: skip a decorator whose identifier
  // demonstrably resolves to something other than `@nestjs/common`'s own
  // `HttpCode` (an unrelated same-named local decorator/function), rather
  // than trusting the name alone — this check runs by default, making it the
  // highest-stakes place in this module to get that wrong.
  const httpCode = decorators.find(
    (d) => d.provenance !== 'mismatch' && (d.resolvedName ?? d.name) === 'HttpCode',
  );

  if (httpCode) {
    const arg = getDecoratorCallArgument(httpCode.node);
    const status = arg ? resolveStatusExpression(arg, checker) : undefined;
    if (status === undefined) return undefined;
    return { status, node: httpCode.node };
  }

  if (httpMethod === 'ALL') return undefined;

  return { status: defaultSuccessStatus(httpMethod), node: methodNode };
}
