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
      (f) => f.handler.className === 'UnresolvableController' && f.handler.methodName === 'multiDecorator',
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
});
