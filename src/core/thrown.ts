/**
 * Walks a function-like body for `ThrowStatement`s that are part of ITS OWN
 * control flow (PLAN §4.1a). Named `collectDirectThrows` (not
 * `collectHandlerThrows`) and typed over `ts.FunctionLikeDeclarationBase`
 * rather than `ts.MethodDeclaration`, because PLAN §4.1b's call graph
 * (Phase 3) needs the identical walk over a called method's body, which may
 * be a `MethodDeclaration`, a `FunctionDeclaration`, or an arrow-function
 * class property initializer — not just a controller handler.
 *
 * ## Nested functions/callbacks: deliberately NOT walked
 *
 * A `throw` inside a nested `function`/arrow/function-expression body
 * (`items.forEach(item => { if (!item) throw new NotFoundException() })`,
 * an event handler passed to something, ...) usually does not propagate to
 * the calling function's own control flow the way a direct throw does — it
 * throws inside whatever *calls* that callback, on whatever tick that
 * happens. This is a deliberate over-approximation toward silence (PLAN
 * §4.2's "bias: silence over noise"), not a sound analysis of when a
 * callback's throw does/doesn't propagate — it is not a general claim that
 * it never does. Known misses (verified — these DO propagate but are
 * currently NOT collected, so they under-report rather than false-positive):
 *
 * - `await (async () => { throw ... })()` — an immediately-invoked,
 *   awaited async arrow function.
 * - `await Promise.all(items.map(async i => { throw ... }))` — an awaited
 *   `Promise.all`/`Promise.race`/... over a `map` of async callbacks.
 * - `await somePromise.then(() => { throw ... })` — an awaited `.then()`
 *   chain.
 *
 * Detached (`items.forEach(cb)`, an unawaited `.map(async ...)`, an event
 * listener) is correctly ignored — that throw does NOT propagate to this
 * function's own response. Phase 3's principled fix is to descend into a
 * callback only when it is syntactically inside an `await`ed expression;
 * not attempted here. Tracked in PLAN §6.
 *
 * ## `try`/`catch`: throws inside a `try` block with a `catch` are not
 * producible (PLAN §4.2 "silence over noise")
 *
 * `try { throw new NotFoundException() } catch { return null }` must not
 * report 404 — the exception never reaches the caller. Only:
 *
 * - throws inside the `catch` block itself (including a bare rethrow), and
 * - throws inside a `finally` block, and
 * - throws inside a `try` block that has NO `catch` (`try { ... } finally
 *   { ... }`, which always propagates)
 *
 * are collected. This is a blanket "suppress everything in a caught `try`
 * block" rule, not a "does this catch rethrow on all paths" analysis —
 * deliberately: proving a catch always rethrows is real control-flow
 * analysis, and guessing wrong in the collecting direction is exactly the
 * false-positive shape PLAN §4.2 rules out. Suppression nests correctly: a
 * `throw` reached only through an *outer* suppressed `try` block stays
 * suppressed even if it's textually inside an inner `catch` (that inner
 * catch's block is still physically inside the outer, catching `try`
 * block).
 *
 * ## Trivially unreachable throws
 *
 * Two cheap, deliberately partial reachability checks (NOT full control-flow
 * analysis — documented gaps below):
 *
 * - A statement following an unconditional `return`/`throw` in the same
 *   block is unreachable and skipped (`return x; throw new Y()` — the throw
 *   never runs).
 * - An `if`/`while` whose condition is the literal `false` (or `0`) is
 *   never entered; its body is skipped.
 *
 * NOT attempted: a `throw` after an `if`/`else` where both branches
 * unconditionally return/throw (needs real reachability analysis across
 * branches), unreachability from a `switch` with no `default` and all cases
 * returning, or unreachability provable only by dead constant-folding a
 * non-trivial condition. These stay collected — i.e. this can still
 * under-collect an unreachable throw as producible, which is the FP-safe
 * direction (a missed *unreachability* only ever adds a spurious finding
 * for an exception that in fact never fires, never removes a real one), but
 * it is a documented, deliberate stopping point, not an oversight.
 *
 * ## `return Promise.reject(...)`: treated as a throw
 *
 * `return Promise.reject(new NotFoundException())` (and its `return await
 * Promise.reject(...)` spelling, and either spelling wrapped in
 * parens/`as .../!`, e.g. `return Promise.reject(x) as never` or `return
 * (await Promise.reject(x))`) rejects the method's returned promise exactly
 * the way a `throw` inside an `async` method does — from the caller's
 * perspective the two are indistinguishable. A bare, statement-level
 * `await Promise.reject(x);` (no `return`) also genuinely propagates the
 * rejection out of the enclosing `async` function and is collected the same
 * way; an *unawaited* `Promise.reject(x);` statement is a floating,
 * unobserved rejection (it does not stop control flow, does not propagate
 * synchronously, and Node will report it as an unhandled rejection rather
 * than route it to this handler's response) and is deliberately NOT
 * collected. `collectDirectThrows` therefore collects:
 *
 * - a `ReturnStatement` whose expression (after unwrapping any
 *   `await`/parens/`as`/`!` wrappers, in any order) is a call to
 *   `Promise.reject(...)` with exactly one argument, and
 * - an `ExpressionStatement` whose expression (after unwrapping
 *   parens/`as`/`!`) is an `await`ed call to `Promise.reject(...)` with
 *   exactly one argument (the `await` is required here — see above),
 *
 * feeding that argument through the identical `resolveThrownStatus` ladder
 * callers already apply to a `throw`'s expression. Same reachability rules
 * apply (try/catch suppression, trivial-unreachability,
 * own-control-flow-only) since both are collected by the same
 * `walkProducibleNodes` walk. `Promise.reject(a, b)` (wrong arity), a
 * rejection value built up in a variable first (`const e = ...; return
 * Promise.reject(e)` — still just an `Identifier` argument, which
 * `resolveThrownStatus` itself may or may not resolve), and
 * `.then(() => Promise.reject(...))` (inside a nested callback, never
 * walked at all — see above) are not specially handled beyond that.
 *
 * The match is purely syntactic — on the literal identifiers
 * `Promise`/`reject`, the same way `resolve-status.ts`'s strategies match
 * built-in exception names before checker-verifying them — rather than
 * checker-verifying `Promise` resolves to the global lib. A local binding
 * that shadows the global `Promise` (`const Promise = { reject: (x) => x
 * }; return Promise.reject(new Error('x'))`) is therefore a real, reachable
 * false positive, not merely a hypothetical one — confirmed empirically.
 * It's accepted rather than guarded against: threading a `TypeChecker` into
 * this otherwise checker-free module to rule out an intentionally-named
 * shadow of a global built-in is judged not worth the complexity, and the
 * realistic version of "shadowing" real code actually does (`import
 * Promise from 'bluebird'`, a spec-compliant `Promise.reject`) behaves
 * identically anyway, so it produces no *wrong* answer even though it isn't
 * literally the global.
 */

import * as ts from 'typescript';

export interface ThrownExpression {
  /**
   * The `throw` statement, `return Promise.reject(...)` statement, or bare
   * `await Promise.reject(...);` expression statement itself, for
   * source-location reporting. NOTE: widened from `ts.ThrowStatement` alone
   * to also include `ts.ReturnStatement` and `ts.ExpressionStatement` — a
   * downstream consumer narrowing this to `ts.ThrowStatement` will now fail
   * to compile.
   */
  node: ts.ThrowStatement | ts.ReturnStatement | ts.ExpressionStatement;
  /** The thrown expression, e.g. the `new NotFoundException(...)` call, a bare identifier, or a `Promise.reject(...)` argument. */
  expression: ts.Expression;
}

/**
 * Strips parens/`as`/`<T>`/`!` wrappers (in any order, repeatedly) around
 * `expr`, stopping at the first `await` or any other node shape. Does NOT
 * unwrap `await` itself — callers decide whether an `await` is required,
 * optional, or must not appear, so unwrapping it here would erase that
 * distinction.
 */
function unwrapNonAwaitWrappers(expr: ts.Expression): ts.Expression {
  let current = expr;
  for (;;) {
    if (ts.isParenthesizedExpression(current)) {
      current = current.expression;
    } else if (ts.isAsExpression(current)) {
      current = current.expression;
    } else if (ts.isTypeAssertionExpression(current)) {
      current = current.expression;
    } else if (ts.isNonNullExpression(current)) {
      current = current.expression;
    } else {
      return current;
    }
  }
}

/**
 * `call` is a call to `Promise.reject(<single argument>)` — returns that
 * argument, or `undefined` if the shape doesn't match. See module doc for
 * why this is purely syntactic (no `TypeChecker` involvement).
 */
function matchPromiseRejectCall(call: ts.Expression): ts.Expression | undefined {
  if (!ts.isCallExpression(call)) return undefined;
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee)) return undefined;
  if (!ts.isIdentifier(callee.expression) || callee.expression.text !== 'Promise') return undefined;
  if (!ts.isIdentifier(callee.name) || callee.name.text !== 'reject') return undefined;
  if (call.arguments.length !== 1) return undefined;
  return call.arguments[0];
}

/**
 * `expr` (a `ReturnStatement`'s expression), after unwrapping any
 * combination of parens/`as`/`!` and optionally a single `await` (in either
 * order — `return await (x as never)` and `return (await x) as never` both
 * unwrap), is a call to `Promise.reject(<single argument>)`. See module
 * doc's "`return Promise.reject(...)`" section.
 */
function getPromiseRejectArgument(expr: ts.Expression): ts.Expression | undefined {
  const beforeAwait = unwrapNonAwaitWrappers(expr);
  const afterAwait = ts.isAwaitExpression(beforeAwait)
    ? unwrapNonAwaitWrappers(beforeAwait.expression)
    : beforeAwait;
  return matchPromiseRejectCall(afterAwait);
}

/**
 * `expr` (an `ExpressionStatement`'s expression, e.g. a bare
 * `await Promise.reject(x);` statement with no `return`), after unwrapping
 * parens/`as`/`!`, is an `await`ed call to `Promise.reject(<single
 * argument>)`. Unlike `getPromiseRejectArgument`, the `await` is REQUIRED —
 * an un-awaited `Promise.reject(x);` statement is a floating rejection that
 * does not propagate to this function's own response (see module doc).
 */
function getAwaitedPromiseRejectStatementArgument(expr: ts.Expression): ts.Expression | undefined {
  const unwrapped = unwrapNonAwaitWrappers(expr);
  if (!ts.isAwaitExpression(unwrapped)) return undefined;
  return matchPromiseRejectCall(unwrapNonAwaitWrappers(unwrapped.expression));
}

function isNestedFunctionLike(node: ts.Node): boolean {
  return (
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  );
}

/** `expr` is the literal `false` or the literal `0` — see module doc's "trivially unreachable" section. */
function isFalsyLiteral(expr: ts.Expression): boolean {
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return true;
  return ts.isNumericLiteral(expr) && Number(expr.text) === 0;
}

/**
 * Walks `fn`'s body applying the exact same reachability rules
 * `collectDirectThrows` documents above (own-control-flow only, try/catch
 * suppression, the two trivial-unreachability checks) and invokes `onNode`
 * for every node visited, tagged with whether it's currently in "producible"
 * territory (i.e. NOT inside a caught `try` block, and not trivially
 * unreachable).
 *
 * Factored out in Phase 3 (PLAN §4.1b) so `call-graph.ts` can find the exact
 * same set of producible `CallExpression`s a call graph should traverse —
 * `try { await this.svc.find() } catch {}` must suppress a call the same way
 * it suppresses a direct `throw`, and duplicating this walk for calls would
 * let the two rulesets drift. `collectDirectThrows` below is now a thin
 * `ThrowStatement`-filtering wrapper over this.
 *
 * Returns without calling `onNode` at all if `fn` has no body, or its body
 * isn't a `Block` (an arrow function's concise `() => expr` body can't
 * syntactically contain a `throw` statement or a statement-level call site
 * the same way).
 */
export function walkProducibleNodes(
  fn: ts.FunctionLikeDeclarationBase,
  onNode: (node: ts.Node, producible: boolean) => void,
): void {
  const body = fn.body;
  if (body === undefined || !ts.isBlock(body)) return;

  function visit(node: ts.Node, producible: boolean): void {
    onNode(node, producible);

    if (ts.isThrowStatement(node)) {
      return;
    }

    // Nested classes can contain methods/constructors of their own; neither
    // those nor any other nested function-like node's body belongs to this
    // function's own control flow (see module doc).
    if (isNestedFunctionLike(node) || ts.isClassLike(node)) return;

    if (ts.isTryStatement(node)) {
      const caught = node.catchClause !== undefined;
      visit(node.tryBlock, producible && !caught);
      if (node.catchClause) visit(node.catchClause.block, producible);
      if (node.finallyBlock) visit(node.finallyBlock, producible);
      return;
    }

    if (ts.isBlock(node)) {
      for (const statement of node.statements) {
        visit(statement, producible);
        // Nothing after an unconditional return/throw in the same block runs.
        if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) break;
      }
      return;
    }

    if (ts.isIfStatement(node)) {
      if (!isFalsyLiteral(node.expression)) visit(node.thenStatement, producible);
      if (node.elseStatement) visit(node.elseStatement, producible);
      return;
    }

    if (ts.isWhileStatement(node)) {
      if (!isFalsyLiteral(node.expression)) visit(node.statement, producible);
      return;
    }

    ts.forEachChild(node, (child) => visit(child, producible));
  }

  visit(body, true);
}

/**
 * Collects every `throw` statement (and `return Promise.reject(...)`, see
 * module doc) that is part of `fn`'s own control flow — i.e. reachable
 * without crossing into a nested function body, not swallowed by an
 * enclosing `try`/`catch`, and not trivially unreachable (see module doc).
 * Returns `[]` if `fn` has no body, or its body isn't a `Block` (an arrow
 * function's concise `() => expr` body can't syntactically contain a
 * `throw` statement).
 */
export function collectDirectThrows(fn: ts.FunctionLikeDeclarationBase): ThrownExpression[] {
  const results: ThrownExpression[] = [];
  walkProducibleNodes(fn, (node, producible) => {
    if (!producible) return;
    if (ts.isThrowStatement(node) && node.expression) {
      results.push({ node, expression: node.expression });
      return;
    }
    if (ts.isReturnStatement(node) && node.expression) {
      const rejectArgument = getPromiseRejectArgument(node.expression);
      if (rejectArgument) results.push({ node, expression: rejectArgument });
      return;
    }
    if (ts.isExpressionStatement(node)) {
      const rejectArgument = getAwaitedPromiseRejectStatementArgument(node.expression);
      if (rejectArgument) results.push({ node, expression: rejectArgument });
    }
  });
  return results;
}
