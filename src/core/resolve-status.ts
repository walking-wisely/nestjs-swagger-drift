/**
 * Resolves a thrown expression to a `ResolvedStatus` (PLAN §4.2).
 *
 * Structured as the ordered strategy ladder PLAN §4.2 describes: `STRATEGIES`
 * is tried in order, each either resolving the expression or returning
 * `undefined` to defer to the next strategy. `resolveThrownStatus` itself is
 * just the loop; Phase 3 (custom exception classes, `extends` chains,
 * `super(msg, ...)` inspection) inserts new strategies into the array
 * without touching this function or the existing strategies' control flow.
 * Phase 2 implements only:
 *
 * 1. `tryHttpExceptionCall` — `new HttpException(msg, <status>)` where
 *    `<status>` is a numeric literal or a resolvable `HttpStatus` member
 *    (PLAN §4.2 steps 2/3 folded together, since Phase 2 doesn't yet
 *    distinguish a custom subclass's `super(...)` call from a direct `new
 *    HttpException(...)` — both are the same shape, a `NewExpression` whose
 *    second argument is the status).
 * 2. `tryBuiltInExceptionClass` — `new <BuiltInException>(...)` — table
 *    lookup, provenance-verified against `@nestjs/common` (PLAN §4.1a).
 *    Deliberately falls through (returns `undefined`, not an `unknown()`)
 *    for BOTH "the callee's provenance is a confirmed mismatch" (a real
 *    app-local `class UserNotFound extends NotFoundException` lands here —
 *    its own name doesn't resolve to `@nestjs/common`) AND "the callee
 *    resolves to `@nestjs/common` but isn't a name in our table" — Phase 3's
 *    extends-chain strategy (PLAN §4.2 step 1) is meant to catch both, and
 *    this is the ONE place in the ladder it needs to be inserted (right
 *    after this strategy), rather than two separately-drifting early
 *    returns.
 * 3. `tryIdentifierRethrow` — `throw <identifier>` where the identifier's
 *    statically-known type is itself a built-in exception class declared in
 *    `@nestjs/common` (PLAN §4.1a's rethrow case) — e.g. `const err = new
 *    NotFoundException(...); ...; throw err;`. A `catch (err)` variable is
 *    typed `unknown`/`any` in modern TS (annotating it with a concrete type
 *    is a compile error), so this deliberately does *not* special-case
 *    `catch` — it falls out of the same general "does this identifier's
 *    type resolve to a known exception class" check.
 *
 * Everything else — a custom exception class (even one that `extends` a
 * built-in, which is Phase 3's job), a dynamically computed status
 * (`throw new HttpException(msg, someVar)`), a thrown non-Error value, an
 * identifier typed `unknown`/`any`/a union — resolves to
 * `{ kind: 'unknown', reason }` and must never manufacture a finding under
 * the default config (PLAN §4.2's "bias: silence over noise").
 */

import * as ts from 'typescript';
import type { ResolvedStatus } from './types.js';
import { checkProvenance, getExpressionName, isDeclarationFromModule } from './provenance.js';
import { resolveStatusExpression } from './status-value.js';
import { BUILTIN_HTTP_EXCEPTIONS } from './nest-exceptions.js';

const NEST_COMMON_MODULE = '@nestjs/common';

function unknown(reason: string): ResolvedStatus {
  return { kind: 'unknown', reason };
}

function resolved(status: number, confidence: 'high' | 'low', exception: string): ResolvedStatus {
  return { kind: 'resolved', status, confidence, exception };
}

/** A resolution strategy: resolves `expression`, or returns `undefined` to defer to the next strategy. */
type Strategy = (expression: ts.Expression, checker: ts.TypeChecker) => ResolvedStatus | undefined;

const tryHttpExceptionCall: Strategy = (expression, checker) => {
  if (!ts.isNewExpression(expression)) return undefined;
  const info = getExpressionName(expression.expression);
  if (!info || info.name !== 'HttpException') return undefined;

  const { provenance } = checkProvenance(info.nameNode, checker, NEST_COMMON_MODULE);
  if (provenance === 'mismatch') return undefined; // a user's own class named HttpException

  const statusArg = expression.arguments?.[1];
  if (!statusArg) {
    return unknown('HttpException thrown without an explicit status argument');
  }
  const status = resolveStatusExpression(statusArg, checker);
  if (status === undefined) {
    return unknown(
      'HttpException status argument is not a resolvable numeric literal or HttpStatus member',
    );
  }
  return resolved(status, 'high', 'HttpException');
};

const tryBuiltInExceptionClass: Strategy = (expression, checker) => {
  if (!ts.isNewExpression(expression)) return undefined;
  const info = getExpressionName(expression.expression);
  if (!info) return undefined;

  const { provenance } = checkProvenance(info.nameNode, checker, NEST_COMMON_MODULE);
  // See this module's doc comment: both of these are Phase 3's extends-chain
  // territory, not resolved here.
  if (provenance === 'mismatch') return undefined;
  const status = BUILTIN_HTTP_EXCEPTIONS[info.name];
  if (status === undefined) return undefined;

  return resolved(status, 'high', info.name);
};

const tryIdentifierRethrow: Strategy = (expression, checker) => {
  if (!ts.isIdentifier(expression)) return undefined;

  let type: ts.Type;
  try {
    type = checker.getTypeAtLocation(expression);
  } catch {
    return unknown('could not resolve the type of the thrown identifier');
  }

  const symbol = type.getSymbol();
  const declarations = symbol?.getDeclarations() ?? [];
  const classDecl = declarations.find(
    (d): d is ts.ClassDeclaration => ts.isClassDeclaration(d) && d.name !== undefined,
  );
  if (!classDecl || !classDecl.name) {
    return unknown(
      'thrown identifier is not statically typed as a specific exception class (e.g. a caught ' +
        '`unknown`/`any` rethrow)',
    );
  }

  const name = classDecl.name.text;
  if (!isDeclarationFromModule(classDecl, NEST_COMMON_MODULE)) {
    return unknown(
      `"${name}" is not declared in @nestjs/common (custom exception classes are Phase 3)`,
    );
  }

  const status = BUILTIN_HTTP_EXCEPTIONS[name];
  if (status === undefined) {
    return unknown(`"${name}" is not a recognized built-in @nestjs/common exception`);
  }
  return resolved(status, 'high', name);
};

const STRATEGIES: readonly Strategy[] = [
  tryHttpExceptionCall,
  tryBuiltInExceptionClass,
  tryIdentifierRethrow,
];

/** Resolves a single thrown expression (from `thrown.ts`) to a `ResolvedStatus`. */
export function resolveThrownStatus(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): ResolvedStatus {
  for (const strategy of STRATEGIES) {
    const result = strategy(expression, checker);
    if (result) return result;
  }
  return unknown(
    'thrown expression did not match any known resolution strategy (not a recognized ' +
      '`new X(...)` call or a class-typed identifier) — not resolvable in Phase 2',
  );
}
