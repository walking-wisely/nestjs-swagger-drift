/**
 * `analyzeHandler()` — the public entry point (PLAN §2.1).
 *
 * Diffs producible statuses against documented statuses (§4.3), honoring
 * `AnalysisOptions.ignoreStatuses`, and emits one `undocumented-status`
 * finding per undocumented status code, carrying every `StatusSource` that
 * can produce it (§4.4). Producible statuses come from direct throws in the
 * handler body (§4.1a), throws reached by bounded traversal into methods the
 * handler calls (§4.1b, `call-graph.ts`), and — as of Phase 5 — the implicit
 * codes of §4.1c: a handler's own success status (`success.ts`, on by
 * default), `ValidationPipe`'s `400` (`validation-pipe.ts`, opt-in), and
 * `@UseGuards(...)`'s `401`/`403` (`guards.ts`, opt-in). Phase 5 also
 * implements the two opt-in rules `AnalysisOptions.rules` was always typed
 * for but left unconsulted: `documented-but-unreachable` and
 * `unresolvable-status` — see their sections below.
 *
 * ## Why success is per-handler, everything else is per-method
 *
 * `collectProducibleStatuses` below computes throws/call-graph/guard/
 * validation-pipe statuses ONCE per `methodNode`, shared across every
 * `HandlerInfo` that method yields — correct, because none of those depend
 * on which HTTP decorator produced a given `HandlerInfo` (a method's body,
 * its guards, and its parameters are the same regardless of whether it's
 * reached via `@Get()` or `@Post()`). The implicit success status is the one
 * exception: NestJS's default success code depends on the HTTP method
 * (`200` vs. `201`), so a method carrying both `@Get()` and `@Post()` (an
 * edge case, but `HandlerInfo`'s array shape exists precisely because
 * `handlers.ts` supports it) has a genuinely different implicit status per
 * `HandlerInfo`. It's therefore computed inside the per-handler loop, not
 * folded into `collectProducibleStatuses`.
 *
 * ## `documented-but-unreachable`: what counts as "reachable"
 *
 * Restricted (Phase 5 review, finding #2) to `level: 'method'` documented
 * statuses only — a class-level `@ApiResponse` commonly reads as a blanket
 * "this whole controller can produce this" statement (a shared `500`, an
 * auth scheme's `401`), not a per-handler claim this rule can meaningfully
 * evaluate one handler at a time, and flagging it on every single handler
 * the class happens to have is exactly the "undermines the whole rule's
 * credibility" spam risk the review called out. A method-level decorator IS
 * a specific, single-handler claim, so it stays in scope.
 *
 * A `level: 'method'` documented numeric status not found in the current
 * run's producible set is "unreachable" — UNLESS excluding it is the
 * FP-safer call:
 *
 * - `500` (Phase 5 review, finding #2): PLAN §6 documents third-party-library
 *   throws Nest maps to `500` as structurally out of scope — this tool has no
 *   detector that could ever attribute a `500` to specific code, so a `500`
 *   not found in the producible set proves nothing about reachability one way
 *   or the other. Excluded unconditionally, independent of `level`.
 * - It's the handler's own implicit success status — see `resolveSuccessStatus`
 *   below for how "own implicit success status" is determined when
 *   `@HttpCode`'s argument isn't statically resolvable (Phase 5 review,
 *   finding #1) — computed regardless of whether `checkSuccessResponse` is
 *   enabled, since NestJS always returns *some* status on a normal return, so
 *   a documented success code is never genuinely unreachable, even when this
 *   run didn't otherwise check for it.
 * - It's `401`/`403`/`400` (Phase 5 review, findings #2/#5): unconditionally
 *   exempt, not merely when `checkGuards`/`checkValidationPipe` is off. The
 *   gap that motivates the exemption — a guard's `canActivate` can `return
 *   false` without throwing (an unattributable `403`/`401` `checkGuards`
 *   cannot see even when enabled, per `checkGuards`'s own doc comment in
 *   `types.ts`), and this tool can never prove `ValidationPipe` is actually
 *   registered, only that a DTO's shape is consistent with it being hit — is
 *   independent of whether the corresponding opt-in check happens to be on:
 *   turning `checkGuards` ON to get MORE guard-throw detection must not make
 *   a documented `403` on a `return false`-style guard start looking
 *   "unreachable" purely because this run's detector doesn't happen to cover
 *   that specific shape. Making the exemption conditional on the flag had
 *   that exact backwards effect (finding #5); unconditional exemption is the
 *   only version that can't regress the moment either check gets better at
 *   finding *some* but not *all* real cases.
 * - `'default'`/a `StatusRange` (`'4XX'`) documented entry — inherently
 *   non-specific, so "unreachable" isn't a meaningful claim about it.
 * - `ignoreStatuses` — same escape hatch as everywhere else.
 *
 * ## `unresolvable-status`: direct handler throws AND call-graph throws
 *
 * A throw whose status `resolve-status.ts` couldn't resolve is reported here
 * when the rule is enabled — both the handler's OWN direct throws (the exact
 * set `collectProducibleStatuses` already resolves and would otherwise
 * silently drop — this rule is precisely "surface what used to be dropped")
 * and, as of Phase 5 review finding #6, unresolved throws reached through the
 * call graph (`call-graph.ts`'s `CallGraphResult.unresolvedThrows`).
 * The previous scoping comment here claimed extending this to call-graph
 * throws would be "a real memory/complexity cost" — false: `computeCacheEntry`
 * already resolves every direct throw in a walked declaration to decide
 * whether it's resolvable at all, so keeping the unresolved ones costs
 * nothing beyond storing a result already computed (see `call-graph.ts`'s
 * `CacheEntry.ownUnresolvedThrows` doc comment). Findings from this source are
 * emitted once per unresolved throw per METHOD, not per `HandlerInfo` — see
 * the per-handler loop below for why.
 */

import * as ts from 'typescript';
import type {
  AnalysisCache,
  AnalysisContext,
  AnalysisOptions,
  Finding,
  HandlerInfo,
  ProducibleStatus,
  StatusSource,
} from './types.js';
import { getHandlerInfosForMethod } from './handlers.js';
import { collectDirectThrows } from './thrown.js';
import { resolveThrownStatus } from './resolve-status.js';
import { getDocumentedStatuses } from './documented.js';
import { collectCallGraphStatuses } from './call-graph.js';
import { checkHandlerSuppression, checkSourceSuppression } from './suppress.js';
import { resolveSuccessStatus } from './success.js';
import { collectValidationPipeSource } from './validation-pipe.js';
import { collectGuardStatuses } from './guards.js';

/**
 * Constructs the opaque `AnalysisCache` (see `types.ts`'s doc comment on
 * `AnalysisCache` — intentionally unconstructible from outside `core/`
 * without this). Phase 2 has no call graph yet, so the cache is inert; it
 * exists now purely so `AnalysisContext` — which requires one — can be
 * constructed at all. Phase 3's call-graph memoization is the first real
 * consumer.
 */
export function createAnalysisCache(): AnalysisCache {
  return {} as unknown as AnalysisCache;
}

/**
 * `ts.Program -> AnalysisCache`, so callers that build a fresh
 * `AnalysisContext` per file (an ESLint rule listening on `MethodDefinition`,
 * one context per lint run) still share a single cache for that `Program` —
 * PLAN §2.1(3)'s "memoize `ts.Symbol -> ProducibleStatus[]` in a `WeakMap`
 * keyed on the Program" exists precisely so re-linting 200 controllers
 * doesn't re-walk `UserService` 200 times. `createAnalysisCache()` above
 * stays available for callers that deliberately want an unshared cache
 * (tests, primarily).
 */
const cachesByProgram = new WeakMap<ts.Program, AnalysisCache>();

function getCacheForProgram(program: ts.Program): AnalysisCache {
  const existing = cachesByProgram.get(program);
  if (existing) return existing;
  const created = createAnalysisCache();
  cachesByProgram.set(program, created);
  return created;
}

/** Convenience constructor for the common case: `program`'s shared cache, checker pulled off `program`. */
export function createAnalysisContext(
  program: ts.Program,
  options: AnalysisOptions,
): AnalysisContext {
  return {
    program,
    checker: program.getTypeChecker(),
    options,
    cache: getCacheForProgram(program),
  };
}

/**
 * Best-effort human-readable label for a thrown expression, for
 * `StatusSource.exception` — used only as a defensive fallback when a
 * `resolveThrownStatus` strategy resolved a status but, unexpectedly,
 * didn't attach an `exception` name (see `ResolvedStatus`'s doc comment;
 * every Phase 2 strategy does attach one, so this path shouldn't normally
 * run).
 */
function describeThrownExpression(expression: ts.Expression): string {
  if (ts.isNewExpression(expression)) {
    const callee = expression.expression;
    if (ts.isIdentifier(callee)) return callee.text;
    if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)) {
      return callee.name.text;
    }
  }
  if (ts.isIdentifier(expression)) return expression.text;
  return expression.getText();
}

function addSource(
  byStatus: Map<number, StatusSource[]>,
  status: number,
  source: StatusSource,
): void {
  const existing = byStatus.get(status);
  if (existing) {
    existing.push(source);
  } else {
    byStatus.set(status, [source]);
  }
}

/**
 * A throw whose status `resolve-status.ts` could not resolve — either a
 * direct throw in `methodNode`'s own body (`via` absent/empty) or one
 * reached through the call graph (Phase 5 review, finding #6; `via` carries
 * the same per-hop call path a resolved `service-throw` source would).
 */
interface UnresolvedThrow {
  node: ts.Node;
  reason: string;
  via: Array<{ name: string; node: ts.Node }>;
}

interface CollectedStatuses {
  statuses: ProducibleStatus[];
  unresolvedThrows: UnresolvedThrow[];
}

/**
 * Producible statuses for `methodNode`, shared across every `HandlerInfo` it
 * yields (see module doc's "why success is per-handler, everything else is
 * per-method"): direct throws (§4.1a), call-graph throws (§4.1b), and — when
 * enabled — guard throws (§4.1c, `guards.ts`) and the `ValidationPipe`
 * implicit `400` (§4.1c, `validation-pipe.ts`). Unresolvable throws are no
 * longer silently dropped (Phase 5): both direct throws and throws reached
 * through the call graph are returned separately as `unresolvedThrows`, for
 * the opt-in `unresolvable-status` rule to consume (see module doc's
 * "unresolvable-status: direct handler throws AND call-graph throws").
 */
function collectProducibleStatuses(
  methodNode: ts.MethodDeclaration,
  classNode: ts.ClassLikeDeclaration,
  ctx: AnalysisContext,
): CollectedStatuses {
  const byStatus = new Map<number, StatusSource[]>();
  const unresolvedThrows: UnresolvedThrow[] = [];

  for (const { node, expression } of collectDirectThrows(methodNode)) {
    const result = resolveThrownStatus(expression, ctx.checker);
    if (result.kind !== 'resolved') {
      unresolvedThrows.push({ node, reason: result.reason, via: [] });
      continue;
    }

    const source: StatusSource = {
      kind: 'throw',
      node,
      exception: result.exception ?? describeThrownExpression(expression),
    };
    addSource(byStatus, result.status, source);
  }

  const callGraph = collectCallGraphStatuses(methodNode, ctx);
  for (const { resolved, source } of callGraph.findings) {
    addSource(byStatus, resolved.status, source);
  }
  for (const { node, reason, via } of callGraph.unresolvedThrows) {
    unresolvedThrows.push({ node, reason, via });
  }

  if (ctx.options.checkGuards ?? false) {
    for (const { resolved, source } of collectGuardStatuses(methodNode, classNode, ctx)) {
      addSource(byStatus, resolved.status, source);
    }
  }

  if (ctx.options.checkValidationPipe ?? false) {
    const source = collectValidationPipeSource(methodNode, ctx.checker);
    if (source) addSource(byStatus, 400, source);
  }

  const statuses = [...byStatus.entries()].map(([status, sources]) => ({
    resolved: { kind: 'resolved' as const, status, confidence: 'high' as const },
    sources,
  }));
  return { statuses, unresolvedThrows };
}

/** A finding `analyzeHandler` dropped because of a `swagger-drift-disable-next-line` directive. */
export interface SuppressedFinding {
  handler: HandlerInfo;
  status: number;
  /** File the suppressing directive lives in (may differ from the handler's own file — see `suppress.ts`). */
  file: string;
  /** 1-based line of the directive comment that suppressed this finding. */
  line: number;
}

/**
 * Analyzes a single method declaration: PLAN §2.1's `analyzeHandler(method,
 * ctx)`. Returns `[]` if `methodNode` isn't an HTTP handler on a
 * `@Controller` class (delegates that determination entirely to
 * `getHandlerInfosForMethod`, so discovery rules never drift between the
 * route table and the analyzer), or if there is provably nothing this run
 * could ever report for it (see the fast-path check below).
 *
 * `onSuppressed`, when given, is invoked once per finding a
 * `swagger-drift-disable-next-line` directive silenced (post-Phase-4-review
 * fix — cross-file suppression, in particular, was previously invisible: a
 * directive in a shared service silently made every calling controller
 * report clean, with no way to see it happened). Callers that want an
 * "audit" mode showing what suppressions are hiding should instead set
 * `ctx.options.ignoreSuppressions`, which skips the suppression checks
 * entirely rather than merely reporting on them. Suppression is NOT applied
 * to `documented-but-unreachable`/`unresolvable-status` findings (Phase 5
 * scope decision, documented here rather than left to be discovered by
 * surprise): both are opt-in rules whose existing suppression-integration
 * need hasn't been demonstrated, and `unresolvable-status` in particular has
 * no natural "status" to key a directive off in the general case.
 *
 * `onAnalyzedFile`, when given, is invoked with the filename of every file
 * this call actually looked at for suppression purposes — `methodNode`'s own
 * file plus every `StatusSource`'s file (which, via cross-file suppression,
 * can be a shared service's file rather than the handler's, or — Phase 5 —
 * a guard's file). A caller doing the S5/S6 "which directives suppressed
 * nothing" scan (`cli/index.ts`) needs this to avoid a false positive of its
 * own: without it, ignoring a controller via `--ignore` makes a shared
 * service's throw — and the `swagger-drift-disable-next-line` above it —
 * unreachable from every *remaining* `analyzeHandler` call, and a scan that
 * doesn't know that would misreport the directive as unused even though it's
 * doing exactly what it always did for the (now-ignored) caller.
 */
export function analyzeHandler(
  methodNode: ts.MethodDeclaration,
  ctx: AnalysisContext,
  onSuppressed?: (suppressed: SuppressedFinding) => void,
  onAnalyzedFile?: (fileName: string) => void,
): Finding[] {
  const handlers = getHandlerInfosForMethod(methodNode, { checker: ctx.checker });
  if (handlers.length === 0) return [];

  // Marked as analyzed here, before any early return below, not only once
  // something producible is known — a handler whose only throw was since
  // removed (leaving a stale directive behind — the exact PLAN §5 Phase 4
  // "one left behind after the throw it targeted was removed" case) must
  // still count as analyzed, or the CLI's unused-directive scan would wrongly
  // treat its file as never reached and silently stop flagging that directive.
  onAnalyzedFile?.(methodNode.getSourceFile().fileName);

  // Safe: `getHandlerInfosForMethod` returning at least one `HandlerInfo`
  // already proves `methodNode.parent` is class-like (it requires exactly
  // that before doing anything else).
  const classNode = methodNode.parent as ts.ClassLikeDeclaration;

  const checkSuccessResponse = ctx.options.checkSuccessResponse ?? true;
  const unreachableRuleEnabled = ctx.options.rules['documented-but-unreachable'];
  const unresolvableRuleEnabled = ctx.options.rules['unresolvable-status'];

  const { statuses: producible, unresolvedThrows } = collectProducibleStatuses(
    methodNode,
    classNode,
    ctx,
  );

  // Fast path: nothing here could ever produce a Finding under the CURRENT
  // options. Mirrors Phase 2–4's original "no producible statuses, bail"
  // shortcut, widened to also require every Phase 5 addition be inert —
  // `checkSuccessResponse` defaults to `true`, so in the default
  // configuration this fast path is essentially never taken, which is
  // intentional (PLAN §4.1c: success-checking should run everywhere).
  if (
    producible.length === 0 &&
    unresolvedThrows.length === 0 &&
    !checkSuccessResponse &&
    !unreachableRuleEnabled
  ) {
    return [];
  }

  if (onAnalyzedFile !== undefined) {
    for (const { sources } of producible) {
      for (const source of sources) onAnalyzedFile(source.node.getSourceFile().fileName);
    }
  }

  const documented = getDocumentedStatuses(methodNode, ctx.checker, ctx.options);
  const documentedStatuses = new Set<number>();
  // A `StatusRange` (`'4XX'`) documents every status whose first digit
  // matches — tracked by that leading digit (`'4'`) rather than by
  // enumerating every status in the range.
  const documentedRangeDigits = new Set<string>();
  let hasWildcard = false;
  for (const d of documented) {
    if (d.status === 'default') {
      hasWildcard = true;
    } else if (typeof d.status === 'number') {
      documentedStatuses.add(d.status);
    } else {
      documentedRangeDigits.add(d.status.charAt(0));
    }
  }
  // A wildcard (`@ApiDefaultResponse` with `treatDefaultAsWildcard: true`,
  // or an unresolvable `@ApiResponse` argument — see `documented.ts`'s S2
  // doc comment) suppresses every status for every handler this method
  // yields for `undocumented-status`, AND makes `documented-but-unreachable`
  // moot for the same reason (there is no way to know what a wildcard was
  // meant to document, so there's nothing to prove unreachable either).
  // Deliberately does NOT also suppress `unresolvable-status` (Phase 5
  // review, finding #8): an unresolvable throw has nothing to do with what a
  // wildcard documents — the two rules ask unrelated questions ("is this
  // throw's status knowable at all" vs. "does some decorator cover it"), so
  // gating the former on the latter was reasoning that only ever applied to
  // the other two rules, ported here by mistake. Guards the two affected
  // rules individually below instead of an early `return []`.

  const ignoreStatuses = new Set(ctx.options.ignoreStatuses);
  const findings: Finding[] = [];

  // Success statuses across EVERY handler this method yields, not just
  // "the current handler in the loop below" (CodeRabbit review on PR #4,
  // verified: `documented` is per-method, so a method carrying both
  // `@Get()` and `@Post()` documents both statuses against the SAME
  // decorator set — a documented 201 is genuinely reachable via the POST
  // route even while iterating the GET handler, and the per-handler
  // `resolveSuccessStatus` call below only ever sees its own route's
  // status). Computed once, up front, so `documented-but-unreachable`'s
  // exemption (below) can check against the whole set instead of
  // accidentally flagging a sibling route's success code as unreachable.
  const allSuccessStatuses = new Set<number>();
  let anySuccessUnresolvable = false;
  for (const h of handlers) {
    const s = resolveSuccessStatus(methodNode, h.httpMethod, ctx.checker);
    if (s) allSuccessStatuses.add(s.status);
    else anySuccessUnresolvable = true;
  }

  for (const handler of handlers) {
    // This handler's own view of "producible": the shared statuses above,
    // plus (Phase 5) its own implicit success status, which — unlike
    // everything else `collectProducibleStatuses` computes — depends on
    // `handler.httpMethod` (see module doc). Merged by status number so a
    // status that's BOTH thrown and the declared success code (a real if
    // unusual `@HttpCode` overlap) reports every source together rather than
    // as two separate findings.
    const byStatus = new Map<number, StatusSource[]>();
    for (const { resolved, sources } of producible) {
      if (resolved.kind !== 'resolved') continue; // always true by construction, narrows the type
      byStatus.set(resolved.status, [...sources]);
    }
    if (checkSuccessResponse) {
      const success = resolveSuccessStatus(methodNode, handler.httpMethod, ctx.checker);
      if (success) {
        const source: StatusSource = { kind: 'implicit', reason: 'success', node: success.node };
        addSource(byStatus, success.status, source);
      }
    }

    // `undocumented-status`/wildcard interaction: a wildcard means "this
    // method might document anything," which is FP-safe grounds to skip
    // BOTH `undocumented-status` (might already be covered) and
    // `documented-but-unreachable` (can't prove anything's NOT covered) —
    // but not `unresolvable-status` (see the "wildcard" comment above).
    if (!hasWildcard) {
      for (const [status, sources] of byStatus) {
        if (documentedStatuses.has(status)) continue;
        if (documentedRangeDigits.has(String(status).charAt(0))) continue;
        if (ignoreStatuses.has(status)) continue;
        // Inline suppression (`suppress.ts`): a directive directly above the
        // handler itself suppresses the whole finding; a directive directly
        // above any individual source (a direct throw, or a service-throw's
        // origin in the callee's file — see `suppress.ts`'s module doc for
        // why that's in scope) does too. Checked last, after the cheap Set
        // lookups above, since it's the only check requiring a source-text
        // scan. `ignoreSuppressions` (an explicit audit mode) skips both
        // checks entirely so every real finding surfaces, suppressed or not.
        if (ctx.options.ignoreSuppressions !== true) {
          const handlerSuppression = checkHandlerSuppression(handler.node, status);
          if (handlerSuppression.suppressed) {
            onSuppressed?.({
              handler,
              status,
              file: handler.node.getSourceFile().fileName,
              line: handlerSuppression.directiveLine ?? 0,
            });
            continue;
          }
          const suppressingSource = sources
            .map((s) => ({ s, check: checkSourceSuppression(s.node, status) }))
            .find(({ check }) => check.suppressed);
          if (suppressingSource !== undefined) {
            onSuppressed?.({
              handler,
              status,
              file: suppressingSource.s.node.getSourceFile().fileName,
              line: suppressingSource.check.directiveLine ?? 0,
            });
            continue;
          }
        }
        findings.push({ rule: 'undocumented-status', status, handler, sources, node: methodNode });
      }

      // `documented-but-unreachable` (Phase 5, opt-in): see module doc for
      // the full "what counts as reachable" reasoning.
      if (unreachableRuleEnabled) {
        // Uses `allSuccessStatuses`/`anySuccessUnresolvable` (computed once,
        // above the handler loop, across every handler this method yields —
        // NOT just this one), per CodeRabbit review on PR #4: `documented`
        // is shared per-method, so a method carrying both `@Get()` and
        // `@Post()` documents both success codes against that same set. A
        // documented 201 is genuinely reachable via the POST route even
        // while this iteration is on the GET handler; checking only the
        // current handler's own success status flagged the sibling route's
        // status as a false "unreachable" (Phase 5 review, finding #1's fix
        // was correct for the single-handler case but missed this one).
        //
        // `anySuccessUnresolvable` mirrors finding #1's reasoning: if ANY
        // handler's `@HttpCode(...)` argument isn't statically resolvable,
        // this tool cannot know that handler's real success status, so per
        // "silence over noise" it must not guess that a documented 2xx is
        // unreachable either — conservative across the whole method, not
        // just the handler whose `@HttpCode` was unresolvable.
        for (const d of documented) {
          if (typeof d.status !== 'number') continue; // 'default' / a StatusRange: not a specific claim
          if (d.level !== 'method') continue; // class-level: see module doc, finding #2
          if (d.status === 500) continue; // structurally out of scope, PLAN §6 / finding #2
          if (ignoreStatuses.has(d.status)) continue;
          if (byStatus.has(d.status)) continue; // genuinely reachable this run
          if (allSuccessStatuses.has(d.status)) continue;
          if (anySuccessUnresolvable && d.status >= 200 && d.status < 300) continue;
          if (d.status === 400 || d.status === 401 || d.status === 403) continue; // see module doc, finding #5
          findings.push({ rule: 'documented-but-unreachable', status: d.status, handler, node: d.node });
        }
      }
    }
  }

  // `unresolvable-status` (Phase 5, opt-in): see module doc's scope note.
  // Emitted once per unresolved throw PER METHOD, not per `HandlerInfo`
  // (Phase 5 review, finding #7 — the nested-in-the-handler-loop version
  // reported every unresolved throw once per HTTP decorator a method
  // carries, e.g. twice for a method with both `@Get()` and `@Post()`, even
  // though it is the exact same physical throw with the exact same node and
  // detail both times). Unlike `undocumented-status`/`documented-but-unreachable`
  // (genuinely per-handler: each handler's OWN documentation is diffed
  // independently), an unresolved throw's unresolvability is a fact about the
  // method's body alone and doesn't vary by which route reveals it, so
  // there's nothing route-specific a second (or third) copy would add —
  // reporting it against every handler would be dead duplicate noise, not
  // signal. Attributed to `handlers[0]` (stable: `getHandlerInfosForMethod`
  // preserves decorator order) purely as a location anchor for the `Finding`
  // shape's required `handler` field.
  if (unresolvableRuleEnabled) {
    const primaryHandler = handlers[0];
    if (primaryHandler !== undefined) {
      for (const { node, reason, via } of unresolvedThrows) {
        const detail = via.length > 0 ? `${via.map((hop) => hop.name).join(' → ')}: ${reason}` : reason;
        findings.push({ rule: 'unresolvable-status', handler: primaryHandler, node, detail });
      }
    }
  }

  return findings;
}
