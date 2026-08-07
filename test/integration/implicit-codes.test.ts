/**
 * Phase 5 (PLAN §4.1c / §5): the implicit-codes checks (`success.ts`,
 * `validation-pipe.ts`, `guards.ts`) and the two opt-in rules `analyze.ts`
 * newly consults (`documented-but-unreachable`, `unresolvable-status`),
 * exercised end to end over `test/fixtures/implicit-codes`.
 *
 * Each `describe` block builds its own `AnalysisOptions` rather than sharing
 * one `expected.json` (unlike `analyze.test.ts`'s `status-diff` suite) —
 * these checks are individually opt-in/opt-out, so the interesting
 * assertion in each case is "on vs. off," not one fixed finding set.
 */
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createProgramFromTsConfig } from '../../src/cli/program.js';
import { discoverHandlerMethodNodes } from '../../src/cli/discover.js';
import {
  analyzeHandler,
  createAnalysisContext,
  type AnalysisOptions,
  type Finding,
} from '../../src/core/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, '../fixtures/implicit-codes');

function baseOptions(overrides: Partial<AnalysisOptions> = {}): AnalysisOptions {
  return {
    maxDepth: 2,
    rules: { 'documented-but-unreachable': false, 'unresolvable-status': false },
    treatDefaultAsWildcard: false,
    ignoreStatuses: [],
    checkSuccessResponse: false,
    checkValidationPipe: false,
    checkGuards: false,
    checkParsePipes: false,
    ...overrides,
  };
}

function analyze(options: AnalysisOptions): Finding[] {
  const outcome = createProgramFromTsConfig(join(FIXTURE_DIR, 'tsconfig.json'));
  if (!outcome.ok) throw new Error('failed to build program for implicit-codes fixture');
  const ctx = createAnalysisContext(outcome.result.program, options);
  const nodes = discoverHandlerMethodNodes(outcome.result.program);
  return nodes.flatMap((n) => analyzeHandler(n, ctx));
}

function findingsFor(findings: Finding[], className: string, methodName: string): Finding[] {
  return findings.filter(
    (f) => f.handler.className === className && f.handler.methodName === methodName,
  );
}

describe('checkSuccessResponse (on by default)', () => {
  it('flags an undocumented GET handler for its implicit 200', () => {
    const findings = analyze(baseOptions({ checkSuccessResponse: true }));
    const list = findingsFor(findings, 'SuccessController', 'list');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ rule: 'undocumented-status', status: 200 });
    if (list[0]?.rule === 'undocumented-status') {
      expect(list[0].sources).toEqual([
        expect.objectContaining({ kind: 'implicit', reason: 'success' }),
      ]);
    }
  });

  it('defaults a POST handler to 201, not 200', () => {
    const findings = analyze(baseOptions({ checkSuccessResponse: true }));
    const create = findingsFor(findings, 'SuccessController', 'create');
    expect(create).toHaveLength(1);
    expect(create[0]).toMatchObject({ status: 201 });
  });

  it('@HttpCode overrides the method-based default', () => {
    const findings = analyze(baseOptions({ checkSuccessResponse: true }));
    const noop = findingsFor(findings, 'SuccessController', 'noop');
    expect(noop).toHaveLength(1);
    expect(noop[0]).toMatchObject({ status: 204 });
  });

  it('a fully documented handler produces no finding', () => {
    const findings = analyze(baseOptions({ checkSuccessResponse: true }));
    expect(findingsFor(findings, 'SuccessController', 'documented')).toEqual([]);
  });

  it('produces none of the above when disabled', () => {
    const findings = analyze(baseOptions({ checkSuccessResponse: false }));
    expect(findings.some((f) => f.handler.className === 'SuccessController')).toBe(false);
  });

  it('is on by default when the option is omitted entirely (AnalysisOptions field is optional)', () => {
    const options = baseOptions();
    // Simulate a caller (an older test, a hand-rolled AnalysisOptions
    // literal) that never mentions the field at all.
    delete (options as { checkSuccessResponse?: boolean }).checkSuccessResponse;
    const findings = analyze(options);
    expect(findingsFor(findings, 'SuccessController', 'list')).toHaveLength(1);
  });

  // Phase 5 review, finding #4: `@Redirect()`/`@Res()` handlers get no
  // implicit-success finding at all — the plain 200/201 default is a real
  // guess for these shapes (NestJS defaults a redirect to 302, and a raw
  // response object bypasses automatic status-setting entirely), so
  // asserting it would be a manufactured finding, not a diagnostic.
  it('produces no implicit-success finding for a @Redirect() handler', () => {
    const findings = analyze(baseOptions({ checkSuccessResponse: true }));
    expect(findingsFor(findings, 'SuccessController', 'redirect')).toEqual([]);
  });

  it('produces no implicit-success finding for a handler taking @Res()', () => {
    const findings = analyze(baseOptions({ checkSuccessResponse: true }));
    expect(findingsFor(findings, 'SuccessController', 'rawResponse')).toEqual([]);
  });

  // Phase 5 review, finding #4: `@All()` without an explicit `@HttpCode` is
  // genuinely unknowable (could serve GET- or POST-like semantics) — no
  // implicit-success finding. WITH an explicit `@HttpCode`, that's a fact,
  // not a guess, so it must still be used.
  it('produces no implicit-success finding for a bare @All() handler', () => {
    const findings = analyze(baseOptions({ checkSuccessResponse: true }));
    expect(findingsFor(findings, 'SuccessController', 'anything')).toEqual([]);
  });

  it('an explicit @HttpCode on an @All() handler is still honored', () => {
    const findings = analyze(baseOptions({ checkSuccessResponse: true }));
    const found = findingsFor(findings, 'SuccessController', 'anythingWithHttpCode');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ status: 201 });
  });

  // Phase 5 review, finding #9: `success.ts`'s `@HttpCode` lookup must apply
  // the same provenance check every other implicit-codes module already
  // does — a same-named LOCAL decorator (not `@nestjs/common`'s own) must
  // not be mistaken for the real `@HttpCode`, or its unresolvable argument
  // would wrongly suppress a genuine undocumented-200 finding.
  it('does not mistake a same-named local decorator for the real @HttpCode', () => {
    const findings = analyze(baseOptions({ checkSuccessResponse: true }));
    const found = findingsFor(findings, 'SuccessShadowedController', 'list');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ status: 200 });
  });

  // Issue #8: `@Sse()` is discovered as a GET route at all (previously
  // invisible to route discovery entirely — see `decorators.test.ts` and
  // `handlers.test.ts` for unit coverage of the discovery half), but a
  // streaming handler has no single implicit success status to assert, same
  // carve-out as `@Redirect()`/`@Res()`.
  it('produces no implicit-success finding for an @Sse() handler', () => {
    const findings = analyze(baseOptions({ checkSuccessResponse: true }));
    expect(findingsFor(findings, 'SuccessController', 'events')).toEqual([]);
  });
});

describe('checkValidationPipe (opt-in)', () => {
  it('flags an implicit 400 for a @Body() class-validator DTO when enabled', () => {
    const findings = analyze(baseOptions({ checkValidationPipe: true }));
    const create = findingsFor(findings, 'ValidationPipeController', 'create');
    expect(create).toHaveLength(1);
    expect(create[0]).toMatchObject({ rule: 'undocumented-status', status: 400 });
    if (create[0]?.rule === 'undocumented-status') {
      expect(create[0].sources).toEqual([
        expect.objectContaining({
          kind: 'implicit',
          reason: 'validation-pipe',
          detail: 'CreateUserDto',
        }),
      ]);
    }
  });

  it('does not flag a @Body() parameter whose DTO has no class-validator decorators', () => {
    const findings = analyze(baseOptions({ checkValidationPipe: true }));
    expect(findingsFor(findings, 'ValidationPipeController', 'createPlain')).toEqual([]);
  });

  it('produces no 400 finding at all when disabled (the default)', () => {
    const findings = analyze(baseOptions({ checkValidationPipe: false }));
    expect(findings.some((f) => f.handler.className === 'ValidationPipeController')).toBe(false);
  });

  // Issue #13a: an array-typed `@Body() items: CreateItemDto[]` must resolve
  // to `CreateItemDto`'s class declaration, not `Array`'s own symbol.
  it('flags an implicit 400 for an ARRAY-typed @Body() class-validator DTO parameter', () => {
    const findings = analyze(baseOptions({ checkValidationPipe: true }));
    const createMany = findingsFor(findings, 'ValidationPipeController', 'createMany');
    expect(createMany).toHaveLength(1);
    expect(createMany[0]).toMatchObject({ rule: 'undocumented-status', status: 400 });
    if (createMany[0]?.rule === 'undocumented-status') {
      expect(createMany[0].sources).toEqual([
        expect.objectContaining({
          kind: 'implicit',
          reason: 'validation-pipe',
          detail: 'CreateItemDto',
        }),
      ]);
    }
  });

  // Issue #13b: a DTO property decorated with a LOCALLY-COMPOSED decorator
  // (`applyDecorators(IsString(), MinLength(8))`) must still count — its own
  // provenance is a confirmed `class-validator` mismatch (it's declared
  // in-app), but its body calls real `class-validator` decorators.
  it('flags an implicit 400 for a DTO validated via a locally-composed decorator', () => {
    const findings = analyze(baseOptions({ checkValidationPipe: true }));
    const createAccount = findingsFor(findings, 'ValidationPipeController', 'createAccount');
    expect(createAccount).toHaveLength(1);
    expect(createAccount[0]).toMatchObject({ rule: 'undocumented-status', status: 400 });
    if (createAccount[0]?.rule === 'undocumented-status') {
      expect(createAccount[0].sources).toEqual([
        expect.objectContaining({
          kind: 'implicit',
          reason: 'validation-pipe',
          detail: 'CreateAccountDto',
        }),
      ]);
    }
  });

  // Issue #13b regression (adversarial-review-confirmed false positive): a
  // locally-composed decorator whose body calls only `class-transformer`'s
  // `Transform` — never a real `class-validator` export — must NOT count.
  it('does not flag a DTO whose composed decorator never calls class-validator', () => {
    const findings = analyze(baseOptions({ checkValidationPipe: true }));
    expect(findingsFor(findings, 'ValidationPipeController', 'createTrimOnly')).toEqual([]);
  });

  // Issue #13b2: the same composed-decorator pattern written as a bare
  // `const` export (`export const X = applyDecorators(...)`, applied as
  // `@X` with no parens) rather than wrapped in a `function`.
  it('flags an implicit 400 for a DTO validated via a const-assigned composed decorator', () => {
    const findings = analyze(baseOptions({ checkValidationPipe: true }));
    const createConstComposed = findingsFor(findings, 'ValidationPipeController', 'createConstComposed');
    expect(createConstComposed).toHaveLength(1);
    expect(createConstComposed[0]).toMatchObject({ rule: 'undocumented-status', status: 400 });
    if (createConstComposed[0]?.rule === 'undocumented-status') {
      expect(createConstComposed[0].sources).toEqual([
        expect.objectContaining({
          kind: 'implicit',
          reason: 'validation-pipe',
          detail: 'ConstComposedDto',
        }),
      ]);
    }
  });

  // Issue #13a (adversarial review, confirmed false negative): under
  // `strict`, an optional parameter's static type widens to `T | undefined`
  // — the pre-fix unwrap (`isArrayType`/`getSymbol()` on the raw union) could
  // not see through that to `CreateUserDto` at all.
  it('flags an implicit 400 for an OPTIONAL @Body() DTO parameter (dto?: X)', () => {
    const findings = analyze(baseOptions({ checkValidationPipe: true }));
    const createOptional = findingsFor(findings, 'ValidationPipeController', 'createOptional');
    expect(createOptional).toHaveLength(1);
    expect(createOptional[0]).toMatchObject({ rule: 'undocumented-status', status: 400 });
    if (createOptional[0]?.rule === 'undocumented-status') {
      expect(createOptional[0].sources).toEqual([
        expect.objectContaining({ kind: 'implicit', reason: 'validation-pipe', detail: 'CreateUserDto' }),
      ]);
    }
  });

  // Issue #13a (adversarial review, confirmed false negative): the fixed
  // array case (issue #13a's own original target), made OPTIONAL
  // (`items?: X[]`) — the array-only fix alone still missed this.
  it('flags an implicit 400 for an OPTIONAL array-typed @Body() DTO parameter (items?: X[])', () => {
    const findings = analyze(baseOptions({ checkValidationPipe: true }));
    const createOptionalItems = findingsFor(findings, 'ValidationPipeController', 'createOptionalItems');
    expect(createOptionalItems).toHaveLength(1);
    expect(createOptionalItems[0]).toMatchObject({ rule: 'undocumented-status', status: 400 });
  });

  // Issue #13a (adversarial review, confirmed false negative): a NULLABLE
  // (not optional) DTO parameter (`dto: X | null`).
  it('flags an implicit 400 for a NULLABLE @Body() DTO parameter (dto: X | null)', () => {
    const findings = analyze(baseOptions({ checkValidationPipe: true }));
    const createNullable = findingsFor(findings, 'ValidationPipeController', 'createNullable');
    expect(createNullable).toHaveLength(1);
    expect(createNullable[0]).toMatchObject({ rule: 'undocumented-status', status: 400 });
  });

  // Issue #13a (adversarial review): a NESTED array (`X[][]`) — the unwrap
  // loop must peel more than one array layer.
  it('flags an implicit 400 for a NESTED array-typed @Body() DTO parameter (items: X[][])', () => {
    const findings = analyze(baseOptions({ checkValidationPipe: true }));
    const createNestedItems = findingsFor(findings, 'ValidationPipeController', 'createNestedItems');
    expect(createNestedItems).toHaveLength(1);
    expect(createNestedItems[0]).toMatchObject({ rule: 'undocumented-status', status: 400 });
  });
});

describe('checkGuards (opt-in)', () => {
  it('flags an implicit 401 for a @UseGuards class whose canActivate throws when enabled', () => {
    const findings = analyze(baseOptions({ checkGuards: true }));
    const list = findingsFor(findings, 'GuardsController', 'list');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ rule: 'undocumented-status', status: 401 });
    if (list[0]?.rule === 'undocumented-status') {
      expect(list[0].sources).toEqual([
        expect.objectContaining({
          kind: 'implicit',
          reason: 'guard',
          detail: 'AuthGuard.canActivate',
        }),
      ]);
    }
  });

  it('walks a bounded ancestor chain to find canActivate on a base guard', () => {
    const findings = analyze(baseOptions({ checkGuards: true }));
    const derived = findingsFor(findings, 'GuardsController', 'derived');
    expect(derived).toHaveLength(1);
    expect(derived[0]).toMatchObject({ status: 401 });
    if (derived[0]?.rule === 'undocumented-status') {
      expect(derived[0].sources[0]).toMatchObject({ detail: 'BaseGuard.canActivate' });
    }
  });

  it('produces no 401/403 findings at all when disabled (the default)', () => {
    const findings = analyze(baseOptions({ checkGuards: false }));
    expect(findings.some((f) => f.handler.className === 'GuardsController')).toBe(false);
  });

  // #11: the common `@nestjs/passport` mixin pattern — `AuthGuard('jwt')`
  // returns a class rather than naming one, whether the call result is
  // stashed in a `const` first or inlined directly in `@UseGuards(...)`.
  it('resolves a guard named by a const holding a mixin factory call result', () => {
    const findings = analyze(baseOptions({ checkGuards: true }));
    const mixinViaConst = findingsFor(findings, 'GuardsController', 'mixinViaConst');
    expect(mixinViaConst).toHaveLength(1);
    expect(mixinViaConst[0]).toMatchObject({ status: 401 });
    if (mixinViaConst[0]?.rule === 'undocumented-status') {
      expect(mixinViaConst[0].sources[0]).toMatchObject({ detail: 'AuthGuardBase.canActivate' });
    }
  });

  it('resolves a guard named by an inline mixin factory call', () => {
    const findings = analyze(baseOptions({ checkGuards: true }));
    const mixinInline = findingsFor(findings, 'GuardsController', 'mixinInline');
    expect(mixinInline).toHaveLength(1);
    expect(mixinInline[0]).toMatchObject({ status: 401 });
    if (mixinInline[0]?.rule === 'undocumented-status') {
      expect(mixinInline[0].sources[0]).toMatchObject({ detail: 'AuthGuardBase.canActivate' });
    }
  });

  // CodeRabbit review on PR #4: the same guard class applied at both
  // class-level and method-level (valid, additive NestJS) must be resolved
  // once, not once per place it's listed — otherwise the same source shows
  // up twice on one finding.
  it('does not duplicate a guard listed at both class level and method level', () => {
    const findings = analyze(baseOptions({ checkGuards: true }));
    const list = findingsFor(findings, 'RedundantGuardController', 'list');
    expect(list).toHaveLength(1);
    if (list[0]?.rule === 'undocumented-status') {
      expect(list[0].sources).toHaveLength(1);
      expect(list[0].sources[0]).toMatchObject({
        kind: 'implicit',
        reason: 'guard',
        detail: 'AuthGuard.canActivate',
      });
    }
  });

  // Handler-specific narrowing (adversarial-testing finding, post-Phase-6):
  // `guard-narrowing.guard.ts`'s `ConditionalThrottleGuard` gates one branch
  // behind a `@OptIn(...)` decorator read via `Reflector`, and another
  // behind an HTTP-method membership check — see `guard-narrowing.controller.ts`
  // for the four handlers, one per combination.
  describe('handler-specific narrowing', () => {
    function statusesFor(findings: Finding[], methodName: string): number[] {
      return findingsFor(findings, 'GuardNarrowingController', methodName)
        .filter((f) => f.rule === 'undocumented-status')
        .map((f) => f.status)
        .sort((a, b) => a - b);
    }

    it('excludes BOTH branches for a handler with neither the decorator nor a write method', () => {
      const findings = analyze(baseOptions({ checkGuards: true }));
      expect(statusesFor(findings, 'noOptInRead')).toEqual([]);
    });

    it('includes BOTH branches for a handler with the decorator AND a write method', () => {
      const findings = analyze(baseOptions({ checkGuards: true }));
      expect(statusesFor(findings, 'optInWrite')).toEqual([403, 409]);
    });

    it('includes only the HTTP-method branch for a write method without the decorator', () => {
      const findings = analyze(baseOptions({ checkGuards: true }));
      expect(statusesFor(findings, 'noOptInWrite')).toEqual([409]);
    });

    it('includes only the metadata branch for a decorated handler that is not a write method', () => {
      const findings = analyze(baseOptions({ checkGuards: true }));
      expect(statusesFor(findings, 'optInRead')).toEqual([403]);
    });

    it('produces no guard findings at all when checkGuards is disabled (sanity control)', () => {
      const findings = analyze(baseOptions({ checkGuards: false }));
      expect(findings.some((f) => f.handler.className === 'GuardNarrowingController')).toBe(false);
    });
  });

  // Code-review round: every recognizer in `guard-narrowing.ts` must only
  // ever narrow on a HIGH-CONFIDENCE match — each case here is a shape that
  // looks superficially like a narrowable gate but must NOT be narrowed
  // (edge-cases-guard.ts), plus the literal-key/nested-factory resolution
  // paths that must correctly narrow when the gate genuinely is absent.
  describe('handler-specific narrowing — edge cases', () => {
    function statusesFor(methodName: string, findings: Finding[]): number[] {
      return findingsFor(findings, 'GuardNarrowingEdgeCasesController', methodName)
        .filter((f) => f.rule === 'undocumented-status')
        .map((f) => f.status)
        .sort((a, b) => a - b);
    }

    it('never narrows a `.get(...)` call on something that is not a Reflector', () => {
      const findings = analyze(baseOptions({ checkGuards: true }));
      expect(statusesFor('mapLookup', findings)).toContain(403);
    });

    it('never narrows an HTTP-method gate for an @All() handler', () => {
      const findings = analyze(baseOptions({ checkGuards: true }));
      expect(statusesFor('allMethod', findings)).toContain(409);
    });

    it('matches a metadata key by resolved literal value, not only by symbol identity', () => {
      const findings = analyze(baseOptions({ checkGuards: true }));
      expect(statusesFor('literalKeyPresent', findings)).toContain(403);
      expect(statusesFor('literalKeyAbsent', findings)).not.toContain(403);
    });

    it('traces a decorator composed via applyDecorators(otherFactory(...))', () => {
      const findings = analyze(baseOptions({ checkGuards: true }));
      expect(statusesFor('nestedFactoryPresent', findings)).toContain(403);
      expect(statusesFor('nestedFactoryAbsent', findings)).not.toContain(403);
    });

    // Verification round, real bug: a depth counter that advanced on every
    // AST step (not just factory-resolution hops) exhausted its budget on
    // ordinary syntax nesting for a FUNCTION-DECLARATION factory with an
    // internal branch, before actually following as many factory hops as
    // intended — silently missing the key. The arrow-function fixture above
    // happened to land inside the (buggy) budget either way, so it alone
    // didn't catch this; this shape does.
    it('traces a nested factory built from branching function-declaration factories', () => {
      const findings = analyze(baseOptions({ checkGuards: true }));
      expect(statusesFor('nestedFactoryFnPresent', findings)).toContain(403);
      expect(statusesFor('nestedFactoryFnAbsent', findings)).not.toContain(403);
    });

    it('never narrows an || condition, even when one operand alone would be provably false', () => {
      const findings = analyze(baseOptions({ checkGuards: true }));
      expect(statusesFor('orCondition', findings)).toContain(403);
    });
  });
});

describe('documented-but-unreachable rule (opt-in)', () => {
  it('flags a documented status nothing in the handler produces when enabled', () => {
    const findings = analyze(
      baseOptions({ rules: { 'documented-but-unreachable': true, 'unresolvable-status': false } }),
    );
    const list = findingsFor(findings, 'UnreachableController', 'list');
    expect(list).toEqual([
      expect.objectContaining({ rule: 'documented-but-unreachable', status: 404 }),
    ]);
  });

  it('is silent when disabled (the default)', () => {
    const findings = analyze(baseOptions());
    expect(findings.some((f) => f.handler.className === 'UnreachableController')).toBe(false);
  });

  // Phase 5 review, finding #1: a non-literal `@HttpCode(...)` argument
  // means `resolveSuccessStatus` can't resolve the handler's real success
  // status — the documented 200 must not be flagged as unreachable even
  // though `checkSuccessResponse` (on by default) never proves it reachable.
  it('does not flag a documented 2xx status when @HttpCode is not statically resolvable', () => {
    const findings = analyze(
      baseOptions({
        checkSuccessResponse: true,
        rules: { 'documented-but-unreachable': true, 'unresolvable-status': false },
      }),
    );
    expect(findingsFor(findings, 'UnreachableController', 'dynamicHttpCode')).toEqual([]);
  });

  // Phase 5 review, finding #2: a class-level `@ApiResponse({ status: 500 })`
  // (and a method-level one) must never be flagged — 500 is structurally out
  // of scope (PLAN §6), and class-level documentation is a blanket claim,
  // not a per-handler one.
  it('never flags a documented 500, class-level or method-level', () => {
    const findings = analyze(
      baseOptions({ rules: { 'documented-but-unreachable': true, 'unresolvable-status': false } }),
    );
    expect(findingsFor(findings, 'ClassLevel500Controller', 'list')).toEqual([]);
    expect(findingsFor(findings, 'ClassLevel500Controller', 'methodLevel')).toEqual([]);
  });

  // Phase 5 review, finding #5: a guard's `canActivate` can `return false`
  // without throwing — `checkGuards` cannot see that shape whether it's on
  // or off, so a documented 403 on such a guard must stay exempt from
  // `documented-but-unreachable` in BOTH states, not just when the check is
  // off (which would be backwards: enabling `checkGuards` to get MORE
  // detection must not start flagging things it still structurally can't see).
  it('does not flag a documented 403 behind a "return false" guard, checkGuards on or off', () => {
    const off = analyze(
      baseOptions({
        checkGuards: false,
        rules: { 'documented-but-unreachable': true, 'unresolvable-status': false },
      }),
    );
    const on = analyze(
      baseOptions({
        checkGuards: true,
        rules: { 'documented-but-unreachable': true, 'unresolvable-status': false },
      }),
    );
    expect(findingsFor(off, 'UnreachableController', 'silentGuard')).toEqual([]);
    expect(findingsFor(on, 'UnreachableController', 'silentGuard')).toEqual([]);
  });

  // CodeRabbit review on PR #4: `documented` is per-method, not per-handler.
  // A method carrying both `@Get()` and `@Post()` documents both success
  // codes against that same shared decorator set — each is genuinely
  // reachable via its own route, even though a single handler's own
  // implicit success status only ever covers one of them.
  it('does not flag either documented success status on a method serving two HTTP verbs', () => {
    const findings = analyze(
      baseOptions({
        checkSuccessResponse: true,
        rules: { 'documented-but-unreachable': true, 'unresolvable-status': false },
      }),
    );
    expect(findingsFor(findings, 'UnreachableController', 'multiVerb')).toEqual([]);
  });
});

describe('unresolvable-status rule (opt-in)', () => {
  it('surfaces a direct throw whose status could not be resolved when enabled', () => {
    const findings = analyze(
      baseOptions({ rules: { 'documented-but-unreachable': false, 'unresolvable-status': true } }),
    );
    const findOne = findingsFor(findings, 'UnresolvableController', 'findOne');
    expect(findOne).toHaveLength(1);
    expect(findOne[0]?.rule).toBe('unresolvable-status');
    if (findOne[0]?.rule === 'unresolvable-status') {
      expect(findOne[0].unresolvableKind).toBe('throw');
    }
  });

  it('is silent when disabled (the default) — the unresolved throw is dropped, not reported as anything', () => {
    const findings = analyze(baseOptions());
    expect(findings.some((f) => f.handler.className === 'UnresolvableController')).toBe(false);
  });

  // Phase 5 review, finding #6: previously scoped to direct handler throws
  // only; an unresolvable throw reached through the call graph must surface
  // too, not be silently dropped the way it was before this fixed the (bogus)
  // "memory/complexity cost" justification.
  it('surfaces an unresolved throw reached through the call graph, not just direct handler throws', () => {
    const findings = analyze(
      baseOptions({ rules: { 'documented-but-unreachable': false, 'unresolvable-status': true } }),
    );
    const viaService = findingsFor(findings, 'UnresolvableController', 'viaService');
    expect(viaService).toHaveLength(1);
    expect(viaService[0]?.rule).toBe('unresolvable-status');
    if (viaService[0]?.rule === 'unresolvable-status') {
      expect(viaService[0].detail).toContain('FlakyService.check');
    }
  });

  // Phase 5 review, finding #7: a method with two HTTP decorators has one
  // physical unresolved throw, not two — must be reported once, not once per
  // decorator (the previous per-`HandlerInfo` nesting reported dead-duplicate
  // findings at the exact same node with no distinguishing information).
  it('reports an unresolved throw once per method, not once per HTTP decorator', () => {
    const findings = analyze(
      baseOptions({ rules: { 'documented-but-unreachable': false, 'unresolvable-status': true } }),
    );
    const multiDecorator = findings.filter(
      (f) =>
        f.handler.className === 'UnresolvableController' &&
        f.handler.methodName === 'multiDecorator',
    );
    expect(multiDecorator).toHaveLength(1);
  });

  // Phase 5 review, finding #8: a wildcard (`@ApiDefaultResponse` with
  // `treatDefaultAsWildcard: true`) must not suppress `unresolvable-status`
  // — it's a documentation-side ambiguity, unrelated to whether a throw's
  // status could be resolved.
  it('is not suppressed by an @ApiDefaultResponse wildcard', () => {
    const findings = analyze(
      baseOptions({
        treatDefaultAsWildcard: true,
        rules: { 'documented-but-unreachable': false, 'unresolvable-status': true },
      }),
    );
    const wildcard = findingsFor(findings, 'UnresolvableController', 'wildcard');
    expect(wildcard).toHaveLength(1);
    expect(wildcard[0]?.rule).toBe('unresolvable-status');
  });

  // Issue #15: a dynamically-valued `@HttpCode(...)` argument previously
  // produced zero findings under any flag — `resolveSuccessStatus` correctly
  // declines to guess, but nothing surfaced that refusal. This asserts the
  // opt-in rule now does, and stays silent when disabled (same "silence over
  // noise" default as everywhere else).
  it('surfaces a handler whose @HttpCode argument could not be statically resolved', () => {
    const findings = analyze(
      baseOptions({
        checkSuccessResponse: true,
        rules: { 'documented-but-unreachable': false, 'unresolvable-status': true },
      }),
    );
    const dynamicHttpCode = findingsFor(findings, 'UnresolvableController', 'dynamicHttpCode');
    expect(dynamicHttpCode).toHaveLength(1);
    expect(dynamicHttpCode[0]?.rule).toBe('unresolvable-status');
    if (dynamicHttpCode[0]?.rule === 'unresolvable-status') {
      expect(dynamicHttpCode[0].detail).toContain('not a statically resolvable literal');
      // Adversarial review: this is a SUCCESS-status finding, not a throw —
      // the reporters must not render "has a throw" for it, and `detail`
      // itself no longer repeats "@HttpCode" (the reporter's `{{what}}` now
      // names the source as "an @HttpCode(...)", so the sentence and detail
      // together read as "has an @HttpCode(...) whose status could not be
      // resolved: argument is not a statically resolvable literal" instead
      // of the earlier redundant "has a success status ... @HttpCode
      // argument is not ...").
      expect(dynamicHttpCode[0].unresolvableKind).toBe('success');
    }
  });

  // Adversarial review: this is success-status analysis, so a user who
  // explicitly disabled `checkSuccessResponse` must not see it resurface
  // under `unresolvable-status` either.
  it('stays silent about a dynamic @HttpCode when checkSuccessResponse is disabled, even with the rule enabled', () => {
    const findings = analyze(
      baseOptions({
        checkSuccessResponse: false,
        rules: { 'documented-but-unreachable': false, 'unresolvable-status': true },
      }),
    );
    expect(findingsFor(findings, 'UnresolvableController', 'dynamicHttpCode')).toEqual([]);
  });

  // Adversarial review: `@HttpCode` on an `@Res()`/`@Redirect()`/`@Sse()`
  // handler is already a known carve-out (automatic status-setting doesn't
  // apply there at all) — must not be misreported as "unresolvable".
  it('does not flag a dynamic @HttpCode on a handler that takes the raw response object', () => {
    const findings = analyze(
      baseOptions({
        checkSuccessResponse: true,
        rules: { 'documented-but-unreachable': false, 'unresolvable-status': true },
      }),
    );
    expect(findingsFor(findings, 'UnresolvableController', 'dynamicHttpCodeWithRes')).toEqual([]);
  });

  it('is silent about the dynamic @HttpCode when the rule is disabled (the default)', () => {
    const findings = analyze(baseOptions());
    expect(findingsFor(findings, 'UnresolvableController', 'dynamicHttpCode')).toEqual([]);
  });
});

describe('checkParsePipes (opt-in, issue #17)', () => {
  it('flags an implicit 400 for a @Param() argument carrying a built-in Parse*Pipe when enabled', () => {
    const findings = analyze(baseOptions({ checkParsePipes: true }));
    const findOne = findingsFor(findings, 'ParsePipesController', 'findOne');
    expect(findOne).toHaveLength(1);
    expect(findOne[0]).toMatchObject({ rule: 'undocumented-status', status: 400 });
    if (findOne[0]?.rule === 'undocumented-status') {
      expect(findOne[0].sources).toEqual([
        expect.objectContaining({
          kind: 'implicit',
          reason: 'parse-pipe',
          detail: 'ParseUUIDPipe',
        }),
      ]);
    }
  });

  it('recognizes a pipe instantiated with new(...), not just a bare class reference', () => {
    const findings = analyze(baseOptions({ checkParsePipes: true }));
    const page = findingsFor(findings, 'ParsePipesController', 'list');
    expect(page).toHaveLength(1);
    expect(page[0]).toMatchObject({ status: 400 });
  });

  it('does not flag a @Param() with no pipe argument', () => {
    const findings = analyze(baseOptions({ checkParsePipes: true }));
    expect(findingsFor(findings, 'ParsePipesController', 'plain')).toEqual([]);
  });

  it('produces no 400 finding at all when disabled (the default)', () => {
    const findings = analyze(baseOptions({ checkParsePipes: false }));
    expect(findings.some((f) => f.handler.className === 'ParsePipesController')).toBe(false);
  });

  // Adversarial review: `new ParseIntPipe({ errorHttpStatusCode:
  // HttpStatus.NOT_ACCEPTABLE })` must report 406, not the default 400 —
  // reporting a flat 400 here would tell the user to document a status the
  // handler can never actually produce.
  it('reports the errorHttpStatusCode override status instead of the default 400', () => {
    const findings = analyze(baseOptions({ checkParsePipes: true }));
    const overridden = findingsFor(findings, 'ParsePipesController', 'overridden');
    expect(overridden).toHaveLength(1);
    expect(overridden[0]).toMatchObject({ rule: 'undocumented-status', status: 406 });
    if (overridden[0]?.rule === 'undocumented-status') {
      expect(overridden[0].sources).toEqual([
        expect.objectContaining({ kind: 'implicit', reason: 'parse-pipe', detail: 'ParseIntPipe' }),
      ]);
    }
  });

  // Adversarial review: `errorHttpStatusCode` present but NOT statically
  // resolvable — must contribute NOTHING, not a guessed 400.
  it('does not flag a Parse*Pipe whose errorHttpStatusCode is not statically resolvable', () => {
    const findings = analyze(baseOptions({ checkParsePipes: true }));
    expect(findingsFor(findings, 'ParsePipesController', 'unresolvableOverride')).toEqual([]);
  });

  // Adversarial review: the array-literal pipe form.
  it('recognizes a pipe named inside an array-literal pipes argument', () => {
    const findings = analyze(baseOptions({ checkParsePipes: true }));
    const arrayForm = findingsFor(findings, 'ParsePipesController', 'arrayForm');
    expect(arrayForm).toHaveLength(1);
    expect(arrayForm[0]).toMatchObject({ status: 400 });
  });

  // Adversarial review: no property-name argument at all.
  it('recognizes a pipe with no property-name argument (@Param(ParseIntPipe))', () => {
    const findings = analyze(baseOptions({ checkParsePipes: true }));
    const noPropertyName = findingsFor(findings, 'ParsePipesController', 'noPropertyName');
    expect(noPropertyName).toHaveLength(1);
    expect(noPropertyName[0]).toMatchObject({ status: 400 });
  });

  // Adversarial review: de-duplicated detail string.
  it('de-duplicates the same pipe name across multiple parameters', () => {
    const findings = analyze(baseOptions({ checkParsePipes: true }));
    const duplicatePipe = findingsFor(findings, 'ParsePipesController', 'duplicatePipe');
    expect(duplicatePipe).toHaveLength(1);
    if (duplicatePipe[0]?.rule === 'undocumented-status') {
      expect(duplicatePipe[0].sources).toEqual([
        expect.objectContaining({ detail: 'ParseIntPipe' }),
      ]);
    }
  });

  // Adversarial review: `@Headers()` is a valid pipe-host decorator too, not
  // just `@Body()`/`@Param()`/`@Query()`.
  it('recognizes a pipe attached to a @Headers() parameter', () => {
    const findings = analyze(baseOptions({ checkParsePipes: true }));
    const headers = findingsFor(findings, 'ParsePipesController', 'headers');
    expect(headers).toHaveLength(1);
    expect(headers[0]).toMatchObject({ status: 400 });
  });

  // Adversarial review: `ParseFilePipe` via `@UploadedFile()` — structurally
  // unreachable under the old Body/Param/Query-only gate.
  it('recognizes ParseFilePipe attached to an @UploadedFile() parameter', () => {
    const findings = analyze(baseOptions({ checkParsePipes: true }));
    const upload = findingsFor(findings, 'ParsePipesController', 'upload');
    expect(upload).toHaveLength(1);
    if (upload[0]?.rule === 'undocumented-status') {
      expect(upload[0].sources).toEqual([
        expect.objectContaining({ detail: 'ParseFilePipe' }),
      ]);
    }
  });

  // Adversarial review, confirmed false positive: `ParseEnumPipe`'s
  // constructor is `(enumType, options?)` — the options object sits at
  // `arguments[1]`, not `arguments[0]`. Hard-coding index 0 silently ignored
  // a resolvable `errorHttpStatusCode` and guessed 400 instead.
  it('reads errorHttpStatusCode off ParseEnumPipe(theEnum, options), not just arguments[0]', () => {
    const findings = analyze(baseOptions({ checkParsePipes: true }));
    const byRole = findingsFor(findings, 'ParsePipesController', 'byRole');
    expect(byRole).toHaveLength(1);
    expect(byRole[0]).toMatchObject({ rule: 'undocumented-status', status: 406 });
  });

  // Adversarial review, confirmed false positive: `exceptionFactory` takes
  // precedence over `errorHttpStatusCode` at runtime — a pipe usage naming
  // one must contribute NOTHING, not a guessed 400.
  it('does not flag a Parse*Pipe whose options carry an exceptionFactory', () => {
    const findings = analyze(baseOptions({ checkParsePipes: true }));
    expect(findingsFor(findings, 'ParsePipesController', 'exceptionFactory')).toEqual([]);
  });

  // Adversarial review, confirmed false positive: shorthand and
  // string-literal property names for `errorHttpStatusCode`.
  it('resolves errorHttpStatusCode given as a shorthand property', () => {
    const findings = analyze(baseOptions({ checkParsePipes: true }));
    const shorthand = findingsFor(findings, 'ParsePipesController', 'shorthandOverride');
    expect(shorthand).toHaveLength(1);
    expect(shorthand[0]).toMatchObject({ status: 406 });
  });

  it('resolves errorHttpStatusCode given as a string-literal property name', () => {
    const findings = analyze(baseOptions({ checkParsePipes: true }));
    const stringLiteral = findingsFor(findings, 'ParsePipesController', 'stringLiteralOverride');
    expect(stringLiteral).toHaveLength(1);
    expect(stringLiteral[0]).toMatchObject({ status: 406 });
  });

  // Adversarial review: `ParseDatePipe` was missing from the built-in set.
  it('recognizes ParseDatePipe as a built-in Parse*Pipe', () => {
    const findings = analyze(baseOptions({ checkParsePipes: true }));
    const dateRange = findingsFor(findings, 'ParsePipesController', 'dateRange');
    expect(dateRange).toHaveLength(1);
    expect(dateRange[0]).toMatchObject({ status: 400 });
  });

  // Adversarial review, confirmed false positive: two distinct pipes on the
  // SAME decorator call must both contribute their own status, not just the
  // first one found.
  it('collects every distinct Parse*Pipe status when more than one pipe is named on the same decorator', () => {
    const findings = analyze(baseOptions({ checkParsePipes: true }));
    const multiPipe = findingsFor(findings, 'ParsePipesController', 'multiPipe');
    const statuses = multiPipe.map((f) => (f.rule === 'undocumented-status' ? f.status : undefined)).sort();
    expect(statuses).toEqual([400, 422]);
  });
});
