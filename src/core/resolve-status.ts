/**
 * Resolves a thrown expression to a `ResolvedStatus` (PLAN §4.2).
 *
 * Structured as the ordered strategy ladder PLAN §4.2 describes: `STRATEGIES`
 * is tried in order, each either resolving the expression or returning
 * `undefined` to defer to the next strategy. `resolveThrownStatus` itself is
 * just the loop. Phase 2 implements the built-in cases:
 *
 * 1. `tryHttpExceptionCall` — `new HttpException(msg, <status>)` where
 *    `<status>` is a numeric literal or a resolvable `HttpStatus` member
 *    (PLAN §4.2 steps 2/3 folded together, since a direct `new
 *    HttpException(...)` and a custom subclass's `super(...)` call are the
 *    same shape, a call whose second argument is the status — the custom-
 *    subclass case is Phase 3's `tryCustomExceptionClass`, which reaches its
 *    own `super(...)` call, not this one).
 * 2. `tryBuiltInExceptionClass` — `new <BuiltInException>(...)` — table
 *    lookup, provenance-verified against `@nestjs/common` (PLAN §4.1a).
 *    Deliberately falls through (returns `undefined`, not an `unknown()`)
 *    for BOTH "the callee's provenance is a confirmed mismatch" (a real
 *    app-local `class UserNotFound extends NotFoundException` lands here —
 *    its own name doesn't resolve to `@nestjs/common`) AND "the callee
 *    resolves to `@nestjs/common` but isn't a name in our table" — Phase 3's
 *    `tryCustomExceptionClass` (PLAN §4.2 step 1) is meant to catch both, and
 *    is inserted right after this strategy for exactly that reason, rather
 *    than two separately-drifting early returns.
 * 3. `tryCustomExceptionClass` (Phase 3) — `new <LocalClass>(...)` where
 *    `<LocalClass>` is NOT itself declared in `@nestjs/common`. Walks the
 *    `extends` chain (`heritage.ts`) to the nearest `@nestjs/common`-verified
 *    ancestor: a concrete built-in (`NotFoundException`, ...) inherits its
 *    fixed status (step 1, whole-chain walk); `HttpException` itself hands
 *    off to `resolveHttpExceptionChainStatus`, which walks back down looking
 *    for the nearest explicit `super(msg, <literal>)` (step 2), `super(msg,
 *    HttpStatus.X)` (step 3, via `status-value.ts`), or a constructor
 *    parameter's literal default forwarded through `super` (step 4, marked
 *    `confidence: 'low'`). An explicit literal at any level wins over an
 *    inherited default further up. See that function's doc comment for the
 *    full "nearest wins" walk.
 * 4. `tryIdentifierRethrow` — `throw <identifier>` where the identifier's
 *    statically-known type is itself a built-in exception class declared in
 *    `@nestjs/common` (PLAN §4.1a's rethrow case) — e.g. `const err = new
 *    NotFoundException(...); ...; throw err;`. A `catch (err)` variable is
 *    typed `unknown`/`any` in modern TS (annotating it with a concrete type
 *    is a compile error), so this deliberately does *not* special-case
 *    `catch` — it falls out of the same general "does this identifier's
 *    type resolve to a known exception class" check. Deliberately NOT
 *    extended to custom exception classes in Phase 3 — a rethrown custom
 *    exception (`const err = new MyException(); ...; throw err;`) stays
 *    `unknown`; narrow, deliberate scope, not an oversight.
 *
 * `resolveThrownStatus` strips a non-null assertion (`throw err!`), a cast
 * (`throw (err as NotFoundException)`, `throw <NotFoundException>err`), a
 * `satisfies` (`throw e satisfies NotFoundException`), and parentheses off
 * the THROWN EXPRESSION AS A WHOLE before any strategy above ever sees it
 * (#14) — see `stripExpressionWrappers`'s doc comment. This is why it's
 * hoisted to the ladder's entry point rather than living inside
 * `tryIdentifierRethrow` alone: `throw (new NotFoundException('x')) as
 * Error` is exactly as resolvable as `throw new NotFoundException('x')`
 * once the wrapper is gone, and every strategy — not just the identifier
 * one — benefits identically.
 *
 * Everything else — a class extending something that only *looks* like a
 * Nest exception (never checker-verified, so it never resolves), a
 * dynamically computed status (`throw new HttpException(msg, someVar)`,
 * `super(msg, cond ? 400 : 409)`), `super(...args)` spread forwarding, a
 * thrown non-Error value, an identifier typed `unknown`/`any`/a union —
 * resolves to `{ kind: 'unknown', reason }` and must never manufacture a
 * finding under the default config (PLAN §4.2's "bias: silence over noise").
 */

import * as ts from 'typescript';
import type { ResolvedStatus } from './types.js';
import { checkProvenance, getExpressionName, isDeclarationFromModule } from './provenance.js';
import { resolveStatusExpression } from './status-value.js';
import { BUILTIN_HTTP_EXCEPTIONS } from './nest-exceptions.js';
import { getBaseClassDeclaration, resolveClassDeclaration } from './heritage.js';

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

/**
 * How a class's own constructor relates to the status it passes to `super`,
 * one level of `resolveHttpExceptionChainStatus`'s walk (PLAN §4.2 steps
 * 2-4). `'forward'` means this class has no constructor of its own — an
 * implicit derived-class constructor forwards every argument to `super(...)`
 * unchanged, so the walk should keep going to the base class. `'dynamic'`
 * means this class DOES have its own constructor but the status it passes
 * (or fails to pass) to `super` isn't a literal the checker can pin down —
 * terminal, not "keep looking at ancestors", because this class has already
 * made its own decision about what to pass, and it's not statically known.
 */
type SuperInspection =
  | { kind: 'literal'; status: number }
  | { kind: 'default'; status: number }
  | { kind: 'dynamic' }
  | { kind: 'forward' };

function isConstructorWithBody(
  member: ts.ClassElement,
): member is ts.ConstructorDeclaration & { body: ts.Block } {
  return ts.isConstructorDeclaration(member) && member.body !== undefined;
}

/**
 * Finds the first `super(...)` call reachable from `body` without crossing
 * into a nested function-like body (mirrors `thrown.ts`'s "own control flow
 * only" walk) — a constructor's `super()` call is not necessarily the first
 * statement (it can be preceded by parameter-default-independent statements
 * in rare cases, or nested in a conditional in stranger ones), so this is a
 * best-effort search rather than "must be `body.statements[0]`".
 */
function findSuperCall(body: ts.Block): ts.CallExpression | undefined {
  let found: ts.CallExpression | undefined;
  function visit(node: ts.Node): void {
    if (found) return;
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.SuperKeyword) {
      found = node;
      return;
    }
    if (
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node) ||
      ts.isClassLike(node)
    ) {
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(body);
  return found;
}

/**
 * Inspects `classDecl`'s own constructor (PLAN §4.2 steps 2-4) to see what
 * status it passes to `super(...)`:
 *
 * - No explicit constructor at all → `'forward'` (the implicit constructor
 *   forwards every argument unchanged; the caller should keep walking up).
 * - An explicit constructor with no discoverable `super(...)` call, or a
 *   `super(...)` call missing a second argument → `'dynamic'`. Deliberately
 *   NOT `'forward'`: an explicit constructor has already taken control away
 *   from simple pass-through, and assuming it still forwards the status
 *   would be a guess (PLAN §4.2 "silence over noise").
 * - `super(...)`'s second argument spread (`super(...args)`, or any spread
 *   anywhere in the argument list, which makes positional indexing
 *   unreliable) → `'dynamic'`, per this task's explicit spread-forwarding
 *   requirement.
 * - A numeric literal, or an `HttpStatus.X` member the checker can fold
 *   (`resolveStatusExpression`, PLAN §4.2 step 3) → `'literal'`.
 * - An identifier matching one of this constructor's OWN parameters, where
 *   that parameter has a literal (or resolvable enum) default → `'default'`
 *   (PLAN §4.2 step 4, low confidence).
 * - Anything else (a computed expression, a ternary, an identifier with no
 *   matching literal-default parameter) → `'dynamic'`.
 */
function inspectConstructorStatus(
  classDecl: ts.ClassLikeDeclaration,
  checker: ts.TypeChecker,
): SuperInspection {
  const ctor = classDecl.members.find(isConstructorWithBody);
  if (!ctor) return { kind: 'forward' };

  const superCall = findSuperCall(ctor.body);
  if (!superCall) return { kind: 'dynamic' };

  const args = superCall.arguments;
  if (args?.some((a) => ts.isSpreadElement(a))) return { kind: 'dynamic' };

  const statusArg = args?.[1];
  if (!statusArg) return { kind: 'dynamic' };

  const literal = resolveStatusExpression(statusArg, checker);
  if (literal !== undefined) return { kind: 'literal', status: literal };

  if (ts.isIdentifier(statusArg)) {
    const param = ctor.parameters.find(
      (p) => ts.isIdentifier(p.name) && p.name.text === statusArg.text,
    );
    if (param?.initializer) {
      const def = resolveStatusExpression(param.initializer, checker);
      if (def !== undefined) return { kind: 'default', status: def };
    }
  }

  return { kind: 'dynamic' };
}

/**
 * Walks from `startClass` (the class actually instantiated by the `new`
 * expression) down through its ancestors up to and including
 * `nearestHttpExceptionSubclass` (the class that directly `extends
 * HttpException`), stopping at the FIRST class whose own constructor
 * resolves or dynamically decides a status — nearest wins, per this task's
 * "explicit `super(msg, <literal>)` wins over an inherited default"
 * requirement. Classes with no constructor of their own (`'forward'`) are
 * skipped over transparently.
 */
function resolveHttpExceptionChainStatus(
  startClass: ts.ClassLikeDeclaration,
  nearestHttpExceptionSubclass: ts.ClassLikeDeclaration,
  checker: ts.TypeChecker,
  label: string,
): ResolvedStatus {
  let node: ts.ClassLikeDeclaration | undefined = startClass;
  while (node) {
    const inspection = inspectConstructorStatus(node, checker);
    if (inspection.kind === 'literal') return resolved(inspection.status, 'high', label);
    if (inspection.kind === 'default') return resolved(inspection.status, 'low', label);
    if (inspection.kind === 'dynamic') {
      return unknown(
        `"${label}"'s status is not a statically resolvable literal (a computed, spread, or ` +
          'otherwise non-literal `super(...)` status argument)',
      );
    }
    if (node === nearestHttpExceptionSubclass) break;
    node = getBaseClassDeclaration(node, checker);
  }
  return unknown(
    `"${label}" extends HttpException but no constructor between it and HttpException sets a ` +
      'statically resolvable status',
  );
}

/**
 * PLAN §4.2 steps 1-4: a custom, app-local exception class — `new
 * SomeCustomException(...)` where `SomeCustomException` is NOT itself
 * declared in `@nestjs/common` (that's `tryBuiltInExceptionClass`'s and
 * `tryHttpExceptionCall`'s territory; both fall through, rather than
 * resolving to `unknown`, precisely so this strategy is reachable — see this
 * module's doc comment).
 *
 * Walks the class's `extends` chain (`heritage.ts`, reused rather than
 * re-walked) looking for the nearest ancestor that is checker-verified
 * (`provenance.ts`) as declared in `@nestjs/common`:
 *
 * - If that ancestor is a concrete built-in exception with a fixed status
 *   (`NotFoundException`, ...) → inherit it (step 1). Concrete built-in
 *   exception constructors only ever accept a `message`, never a status, so
 *   there is nothing to override here.
 * - If that ancestor is `HttpException` itself (the one built-in whose
 *   status IS a constructor argument) → steps 2-4 kick in:
 *   `resolveHttpExceptionChainStatus` walks back down from `startClass`
 *   looking for the nearest explicit `super(msg, <status>)`.
 * - If the chain never reaches `@nestjs/common` at all (extends nothing, or
 *   extends only other local classes with no such ancestor) → `undefined`,
 *   deferring to the ladder's final "unknown" default. This is the
 *   "something that merely *looks* like a Nest exception" case: nothing
 *   here is checker-verified against the real module, so it never resolves.
 */
const tryCustomExceptionClass: Strategy = (expression, checker) => {
  if (!ts.isNewExpression(expression)) return undefined;
  const startClass = resolveClassDeclaration(expression.expression, checker);
  if (!startClass?.name) return undefined;
  // Already handled (or deliberately not) by the built-in strategies above.
  if (isDeclarationFromModule(startClass, NEST_COMMON_MODULE)) return undefined;

  const label = startClass.name.text;
  const MAX_DEPTH = 20;
  const visited = new Set<ts.ClassLikeDeclaration>();
  let current: ts.ClassLikeDeclaration = startClass;

  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    if (visited.has(current)) {
      return unknown(`"${label}" has a circular \`extends\` chain`);
    }
    visited.add(current);

    const base = getBaseClassDeclaration(current, checker);
    if (!base) {
      // Ends in a class with no resolvable `extends` at all (including
      // "extends something that only looks like a Nest exception" — an
      // unresolved/unrelated base never gets here in the first place).
      return undefined;
    }

    if (isDeclarationFromModule(base, NEST_COMMON_MODULE)) {
      const baseName = base.name?.text;
      if (baseName === 'HttpException') {
        return resolveHttpExceptionChainStatus(startClass, current, checker, label);
      }
      const fixedStatus = baseName ? BUILTIN_HTTP_EXCEPTIONS[baseName] : undefined;
      if (fixedStatus !== undefined) {
        return resolved(fixedStatus, 'high', label);
      }
      return unknown(
        `"${label}" extends @nestjs/common's "${baseName ?? '<anonymous>'}", which is neither ` +
          'HttpException nor a recognized built-in HTTP exception',
      );
    }

    current = base;
  }

  return unknown(`"${label}"'s \`extends\` chain is too deep to resolve`);
};

/**
 * Strips wrapper expressions that only ANNOTATE what's thrown, never
 * change WHAT is actually thrown at runtime, off the top of `expression`
 * (#14): `throw err!`'s `NonNullExpression`, `throw (err as X)`'s
 * `AsExpression`, `throw <X>err`'s `TypeAssertionExpression` (the
 * angle-bracket cast form), `throw e satisfies X`'s `SatisfiesExpression`,
 * and any enclosing `ParenthesizedExpression` — in any order, repeated
 * (`throw (err!)`, `throw (err as X)!`, ...). Called once, at
 * `resolveThrownStatus`'s entry point, on the whole thrown expression —
 * not just when it happens to wrap an identifier — so `throw (new
 * NotFoundException('x')) as Error` reaches `tryBuiltInExceptionClass` as
 * plainly as `throw new NotFoundException('x')` does (adversarial review
 * P7: a cast/non-null/parens wrapper around a `new X(...)` call, not just
 * around an identifier, was previously invisible to every strategy).
 *
 * None of these wrappers changes what the checker can PROVE about the
 * underlying expression's type — a non-null assertion only removes
 * `null`/`undefined` from a type the checker already knows is otherwise
 * correct (safe to trust: `tryIdentifierRethrow` additionally calls
 * `checker.getNonNullableType` so a `throw err!` where `err`'s declared
 * type is `NotFoundException | undefined` resolves, not just the redundant
 * `!` on an already-narrowed type — adversarial review P6). An `as X`/
 * `<X>`/`satisfies X`, by contrast, is an unverified assertion, not proof —
 * stripping the WRAPPER here does not mean trusting X; the strategies below
 * still resolve the TYPE from the checker at the unwrapped expression's own
 * location, never from the asserted type, preserving this module's
 * "silence over noise" bias (see this module's doc comment): a `catch
 * (err)` variable cast with `as NotFoundException` stays statically
 * `unknown` and still resolves to `unknown` here, exactly as it would have
 * without the cast.
 */
function stripExpressionWrappers(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isNonNullExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isParenthesizedExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

const tryIdentifierRethrow: Strategy = (expression, checker) => {
  if (!ts.isIdentifier(expression)) return undefined;

  let type: ts.Type;
  try {
    // `getNonNullableType` strips `null`/`undefined` constituents from the
    // identifier's own checker-known type — a no-op when the type already
    // excludes them (the common case), and what makes `throw err!` resolve
    // even when the `!` isn't redundant, e.g. `err`'s declared type is
    // `NotFoundException | undefined` (#14 P6). It does NOT trust anything
    // from a cast: by the time control reaches here, `stripExpressionWrappers`
    // has already discarded any `as`/`satisfies`/angle-bracket wrapper, and
    // this reads the TYPE straight from the checker at the bare identifier.
    type = checker.getNonNullableType(checker.getTypeAtLocation(expression));
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
  tryCustomExceptionClass,
  tryIdentifierRethrow,
];

/** Resolves a single thrown expression (from `thrown.ts`) to a `ResolvedStatus`. */
export function resolveThrownStatus(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): ResolvedStatus {
  const stripped = stripExpressionWrappers(expression);
  for (const strategy of STRATEGIES) {
    const result = strategy(stripped, checker);
    if (result) return result;
  }
  return unknown(
    'thrown expression did not match any known resolution strategy (not a recognized ' +
      '`new X(...)` call or a class-typed identifier) — not resolvable in Phase 2',
  );
}
