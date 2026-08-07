/**
 * `RuleTester` suite for `nestjs-swagger-drift/documented-status-codes`
 * (PLAN §5 Phase 6). Runs the rule against real files inside the existing
 * `test/fixtures/*` projects (not synthetic inline `code` strings) so the
 * rule is exercised through a genuine type-aware `ts.Program`, the same way
 * `test/integration/*.test.ts` exercises `analyzeHandler` directly — see
 * `documented-status-codes-equivalence.test.ts` for the test that both
 * drivers agree on a whole fixture, not just individual cases.
 *
 * `@typescript-eslint/rule-tester`'s `RuleTester` defaults to reading
 * `describe`/`it` off the global scope (its own doc: "This class defaults to
 * using functions defined on the global scope"), which this repo's Vitest
 * config does not populate (`vitest.config.ts` has no `test.globals: true`,
 * matching every other test file's explicit `import { describe, it } from
 * 'vitest'`) — so this file wires Vitest's functions in explicitly, the
 * documented integration path for non-Jest/Mocha runners.
 */

import { RuleTester, type TestLanguageOptions } from '@typescript-eslint/rule-tester';
import parser from '@typescript-eslint/parser';
import { afterAll, describe, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { documentedStatusCodesRule } from '../../src/eslint/rules/documented-status-codes.js';

RuleTester.describe = describe as unknown as typeof RuleTester.describe;
RuleTester.it = it as unknown as typeof RuleTester.it;
RuleTester.itOnly = it.only as unknown as typeof RuleTester.itOnly;
RuleTester.afterAll = afterAll as unknown as typeof RuleTester.afterAll;

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATUS_DIFF_DIR = join(__dirname, '../fixtures/status-diff');
const IMPLICIT_CODES_DIR = join(__dirname, '../fixtures/implicit-codes');

/** Reads a fixture file's real on-disk content — see module doc: `code` must match disk exactly for the type-aware parser to resolve cleanly. */
function readFixture(fixtureDir: string, relativePath: string): string {
  return readFileSync(join(fixtureDir, relativePath), 'utf8');
}

function languageOptionsFor(fixtureDir: string): TestLanguageOptions {
  return {
    parserOptions: {
      // Relative to `tsconfigRootDir`, not absolute — typescript-eslint
      // joins the two, and an already-absolute `project` here produced a
      // doubled, unresolvable path ("<tsconfigRootDir>/Users/...").
      project: './tsconfig.json',
      tsconfigRootDir: fixtureDir,
    },
  };
}

const ruleTester = new RuleTester({
  languageOptions: { parser },
});

ruleTester.run('documented-status-codes', documentedStatusCodesRule, {
  valid: [
    {
      // Fully documented via the generic `@ApiResponse({ status })` form,
      // AND its implicit 200 success status — `checkSuccessResponse: false`
      // here isolates this case to the throw/decorator diff (see
      // `documented-status-codes-equivalence.test.ts` for a run at the
      // real default).
      name: 'a fully-documented handler (generic @ApiResponse) reports nothing',
      code: readFixture(STATUS_DIFF_DIR, 'src/documented-generic.controller.ts'),
      filename: 'src/documented-generic.controller.ts',
      languageOptions: languageOptionsFor(STATUS_DIFF_DIR),
      options: [{ checkSuccessResponse: false }],
    },
    {
      // Documented via the shorthand decorator family instead of the
      // generic form — same "reports nothing" bar, different code path in
      // `core/documented.ts`.
      name: 'a fully-documented handler (shorthand decorator) reports nothing',
      code: readFixture(STATUS_DIFF_DIR, 'src/documented-shorthand.controller.ts'),
      filename: 'src/documented-shorthand.controller.ts',
      languageOptions: languageOptionsFor(STATUS_DIFF_DIR),
      options: [{ checkSuccessResponse: false }],
    },
    {
      // `ignoreStatuses` (mirrors the CLI's `--ignore-status`): the same 404
      // that's flagged in the "undocumented status" invalid case below must
      // report nothing once 404 is ignored.
      name: 'ignoreStatuses suppresses a status that would otherwise be flagged',
      code: readFixture(STATUS_DIFF_DIR, 'src/undocumented.controller.ts'),
      filename: 'src/undocumented.controller.ts',
      languageOptions: languageOptionsFor(STATUS_DIFF_DIR),
      options: [{ checkSuccessResponse: false, ignoreStatuses: [404] }],
    },
    {
      // `documented-but-unreachable` stays silent when NOT enabled (its
      // default) even though `list()` documents a 404 nothing in its body
      // produces — see the invalid case below for the same handler with the
      // rule turned on.
      name: 'documented-but-unreachable produces no finding when the rule is disabled (default)',
      code: readFixture(IMPLICIT_CODES_DIR, 'src/unreachable.controller.ts'),
      filename: 'src/unreachable.controller.ts',
      languageOptions: languageOptionsFor(IMPLICIT_CODES_DIR),
      // `checkSuccessResponse: false`: this fixture predates/is unrelated to
      // success-response checking, and one of its handlers
      // (`silentGuard`) doesn't itself document its implicit 200 — without
      // this, that unrelated `undocumented-status` finding would make this
      // "produces no finding" case fail for a reason that has nothing to do
      // with what's under test here.
      options: [
        { checkSuccessResponse: false, rules: { 'documented-but-unreachable': false, 'unresolvable-status': false } },
      ],
    },
    {
      // `unresolvable-status` stays silent when NOT enabled (its default),
      // even though `findOne`'s throw has a genuinely unresolvable status —
      // it's just dropped, per PLAN §4.2's "silence over noise".
      name: 'unresolvable-status produces no finding when the rule is disabled (default)',
      code: readFixture(IMPLICIT_CODES_DIR, 'src/unresolvable.controller.ts'),
      filename: 'src/unresolvable.controller.ts',
      languageOptions: languageOptionsFor(IMPLICIT_CODES_DIR),
      options: [{ checkSuccessResponse: false }],
    },
    {
      // `maxDepth: 1` stops the call-graph traversal one hop short of
      // `OrgRepository.save`'s throw (controller -> service is hop 1,
      // service -> repository is hop 2) — see the invalid case below with
      // the default `maxDepth: 2`, which does reach it.
      name: 'maxDepth: 1 does not reach a throw two call-graph hops away',
      code: readFixture(STATUS_DIFF_DIR, 'src/two-hop.controller.ts'),
      filename: 'src/two-hop.controller.ts',
      languageOptions: languageOptionsFor(STATUS_DIFF_DIR),
      options: [{ checkSuccessResponse: false, maxDepth: 1 }],
    },
  ],
  invalid: [
    {
      // The base case (mirrors the CLI's Phase 2 exit criterion): a direct
      // `throw new NotFoundException(...)` with no `@ApiResponse` at all.
      name: 'an undocumented direct throw is flagged',
      code: readFixture(STATUS_DIFF_DIR, 'src/undocumented.controller.ts'),
      filename: 'src/undocumented.controller.ts',
      languageOptions: languageOptionsFor(STATUS_DIFF_DIR),
      options: [{ checkSuccessResponse: false }],
      errors: [
        {
          messageId: 'undocumentedStatus',
          data: {
            handlerLabel: 'GET /widgets/:id (UndocumentedController.findOne)',
            status: '404',
            exceptions: 'NotFoundException',
          },
          // m11: anchored at the handler's own `MethodDefinition`
          // (`findOne`), not e.g. the enclosing class — catches a regression
          // that anchored `undocumented-status` findings at the wrong node.
          line: 8,
          column: 3,
        },
      ],
    },
    {
      // `documented-but-unreachable`, enabled: `list()` documents 404 (and
      // 200, its real success status) but its body never throws — 404 is
      // the unreachable one; 200 is exempt (it's the handler's own implicit
      // success status — see `analyze.ts`'s module doc).
      name: 'documented-but-unreachable flags a documented status nothing produces, when enabled',
      code: readFixture(IMPLICIT_CODES_DIR, 'src/unreachable.controller.ts'),
      filename: 'src/unreachable.controller.ts',
      languageOptions: languageOptionsFor(IMPLICIT_CODES_DIR),
      // `checkSuccessResponse: false` — see the matching "disabled" valid
      // case above for why (`silentGuard`'s own undocumented implicit 200 is
      // unrelated to what this case is about).
      options: [
        { checkSuccessResponse: false, rules: { 'documented-but-unreachable': true, 'unresolvable-status': false } },
      ],
      errors: [
        {
          messageId: 'documentedButUnreachable',
          data: {
            handlerLabel: 'GET /unreachable (UnreachableController.list)',
            status: '404',
          },
          // m11: anchored at the `@ApiNotFoundResponse()` decorator itself
          // (the documented status's own node), not the method or class.
          line: 22,
          column: 3,
        },
      ],
    },
    {
      // `unresolvable-status`, enabled: `throw new HttpException(msg, dynamicStatus)`
      // whose status is a runtime value, not a literal — resolvable to
      // nothing, surfaced instead of silently dropped. This fixture's
      // `UnresolvableController` has five such handlers (a direct throw, one
      // reached one call-graph hop away, one shared by two HTTP decorators
      // on the same method — reported once, not twice — one behind an
      // `@ApiDefaultResponse` wildcard, which does NOT suppress this rule —
      // see `analyze.ts`'s module doc — and, issue #15, one whose
      // `@HttpCode(...)` argument is itself dynamically valued), so all five
      // are asserted here rather than narrowing the fixture: this rule's
      // "surface every unresolvable status" contract is exactly what having
      // all five catches.
      name: 'unresolvable-status flags every throw whose status could not be resolved, when enabled',
      code: readFixture(IMPLICIT_CODES_DIR, 'src/unresolvable.controller.ts'),
      filename: 'src/unresolvable.controller.ts',
      languageOptions: languageOptionsFor(IMPLICIT_CODES_DIR),
      options: [
        {
          checkSuccessResponse: false,
          rules: { 'documented-but-unreachable': false, 'unresolvable-status': true },
        },
      ],
      errors: [
        {
          messageId: 'unresolvableStatus',
          data: {
            handlerLabel: 'GET /unresolvable/via-service/:id (UnresolvableController.viaService)',
            detail: 'FlakyService.check: HttpException status argument is not a resolvable numeric literal or HttpStatus member',
          },
        },
        {
          messageId: 'unresolvableStatus',
          data: {
            handlerLabel: 'GET /unresolvable/:id (UnresolvableController.findOne)',
            detail: 'HttpException status argument is not a resolvable numeric literal or HttpStatus member',
          },
        },
        {
          messageId: 'unresolvableStatus',
          data: {
            handlerLabel: 'GET /unresolvable/multi-decorator/:id (UnresolvableController.multiDecorator)',
            detail: 'HttpException status argument is not a resolvable numeric literal or HttpStatus member',
          },
        },
        {
          messageId: 'unresolvableStatus',
          data: {
            handlerLabel: 'GET /unresolvable/wildcard/:id (UnresolvableController.wildcard)',
            detail: 'HttpException status argument is not a resolvable numeric literal or HttpStatus member',
          },
        },
        {
          messageId: 'unresolvableStatus',
          data: {
            handlerLabel: 'POST /unresolvable/dynamic-http-code (UnresolvableController.dynamicHttpCode)',
            detail: '@HttpCode argument is not a statically resolvable literal',
          },
        },
      ],
    },
    {
      // m6 (Phase 6 ESLint-plugin review): a genuinely cross-FILE
      // `unresolvable-status` finding — the throw lives in
      // `unresolvable-cross-file.service.ts`, a DIFFERENT file from the
      // handler being linted, so `services.tsNodeToESTreeNodeMap` has no
      // entry for it and `reportNodeFor`'s fallback to the handler
      // `MethodDefinition` node is what actually anchors this report. Every
      // other `unresolvable-status` case above happens to have its throw in
      // the SAME file as the handler (even `viaService` in
      // `unresolvable.controller.ts`: `FlakyService` is a second class, but
      // still the same file), so none of them exercise that fallback path —
      // this case specifically does.
      name: 'unresolvable-status anchors at the handler method, without crashing, for a throw reached via a DIFFERENT file',
      code: readFixture(IMPLICIT_CODES_DIR, 'src/unresolvable-cross-file.controller.ts'),
      filename: 'src/unresolvable-cross-file.controller.ts',
      languageOptions: languageOptionsFor(IMPLICIT_CODES_DIR),
      options: [
        {
          checkSuccessResponse: false,
          rules: { 'documented-but-unreachable': false, 'unresolvable-status': true },
        },
      ],
      errors: [
        {
          messageId: 'unresolvableStatus',
          data: {
            handlerLabel: 'GET /unresolvable-cross-file/:id (UnresolvableCrossFileController.viaService)',
            detail:
              'FlakyCrossFileService.check: HttpException status argument is not a resolvable numeric literal or HttpStatus member (at ' +
              join(IMPLICIT_CODES_DIR, 'src/unresolvable-cross-file.service.ts') +
              ':15)',
          },
          // m11: anchored at the handler's own `MethodDefinition` (the
          // `reportNodeFor` fallback — see above), NOT at line 1 or some
          // other wrong node — this is exactly the kind of anchoring
          // regression (e.g. reporting at the class instead of the method)
          // that an assertion-free suite wouldn't catch.
          line: 12,
          column: 3,
        },
      ],
    },
    {
      // The default `maxDepth: 2` DOES reach `OrgRepository.save`'s throw
      // two hops from the controller — the counterpart to the `maxDepth: 1`
      // valid case above.
      name: 'the default maxDepth reaches a throw two call-graph hops away',
      code: readFixture(STATUS_DIFF_DIR, 'src/two-hop.controller.ts'),
      filename: 'src/two-hop.controller.ts',
      languageOptions: languageOptionsFor(STATUS_DIFF_DIR),
      options: [{ checkSuccessResponse: false }],
      errors: [
        {
          messageId: 'undocumentedStatus',
          data: {
            handlerLabel: 'POST /orgs (TwoHopController.create)',
            status: '409',
            exceptions: 'ConflictException',
          },
        },
      ],
    },
  ],
});
