/**
 * `nestjs-swagger-drift/documented-status-codes` — the ESLint adapter for
 * `core/analyze.ts`'s `analyzeHandler()` (PLAN §2.1, §5 Phase 6).
 *
 * This file is intentionally thin: PLAN §3's hard rule ("nothing under
 * `core/` may be duplicated; `src/eslint/` only translates") means every bit
 * of actual analysis logic — throw resolution, the call graph, decorator
 * parsing, the documented/producible diff — lives in `core/` and is called,
 * never reimplemented, here. What this file adds is exactly the three things
 * PLAN §2.1 says an ESLint driver needs on top of a pure `analyzeHandler`:
 *
 * 1. A listener on the ESTree node that corresponds to a `ts.MethodDeclaration`
 *    — `MethodDefinition` (a class method; typescript-eslint's parser gives
 *    an *abstract* method its own `TSAbstractMethodDefinition` type, which
 *    this rule does not listen on, since an abstract method has no body for
 *    `analyzeHandler` to inspect and `getHandlerInfosForMethod` would find no
 *    HTTP decorators on it anyway — see `core/handlers.ts`).
 * 2. Mapping the ESTree node to its `ts.Node` (`esTreeNodeToTSNodeMap`) to
 *    call into `core/`, and mapping each `Finding.node` back to an ESTree
 *    node (`tsNodeToESTreeNodeMap`) to anchor `context.report()`.
 * 3. Translating `AnalysisOptions` to/from ESLint's `meta.schema` + `context.report`'s
 *    `messageId`/`data` contract (ESLint rules cannot report a free-form
 *    string — only a `messageId` resolved against `meta.messages`).
 *
 * ## Required user configuration
 *
 * Like any type-aware typescript-eslint rule, this one needs a real
 * `ts.Program` — `getParserServices` throws a clear, actionable error itself
 * if one isn't available. Users must set `languageOptions.parserOptions.projectService: true`
 * (typescript-eslint v8+) or `project: './tsconfig.json'` in their flat
 * config. See the plugin's `index.ts` doc comment and the README for a
 * worked example. This is a config burden on the plugin's *user*, not
 * something this rule can paper over (PLAN §2.1(1)).
 *
 * ## What's deliberately NOT here
 *
 * - No autofix (`fix()`) — that's Phase 7, out of scope for this file.
 * - No second cache: `createAnalysisContext(services.program, options)` is
 *   called once per `MethodDefinition` visit, which looks wasteful but isn't
 *   — `AnalysisContext` is a handful of fields, and the actual expensive
 *   state (the call-graph memoization) lives in `AnalysisCache`, which
 *   `createAnalysisContext` resolves from a `WeakMap<ts.Program, AnalysisCache>`
 *   keyed on `services.program` (see `analyze.ts`'s `getCacheForProgram`).
 *   Since typescript-eslint hands every file in one lint run the SAME
 *   `ts.Program` (under `projectService`/`project`), that cache is
 *   automatically shared across every controller this rule visits in the
 *   run — exactly PLAN §2.1(3)'s "re-linting 200 controllers doesn't re-walk
 *   `UserService` 200 times," without this file building anything of its own.
 * - No `ignoreSuppressions`/`--audit` equivalent option: `AnalysisOptions.ignoreSuppressions`
 *   is left unwired here by judgment call. The CLI's `--audit` flag exists
 *   because a CI job wants an occasional one-off "show me everything
 *   suppressions are hiding" run; an ESLint rule option doesn't have an
 *   obviously-idiomatic equivalent (there's no "run once in audit mode"
 *   concept in a lint config, and `// swagger-drift-disable-next-line` itself
 *   already coexists fine with ESLint's own `// eslint-disable-next-line`
 *   directives, so there's no urgent gap to fill). Revisit if a real user
 *   asks for it.
 */

import * as ts from 'typescript';
import { ESLintUtils } from '@typescript-eslint/utils';
import type { TSESTree } from '@typescript-eslint/utils';
import type {
  AnalysisOptions,
  Finding,
} from '../../core/index.js';
import { analyzeHandler, createAnalysisContext } from '../../core/index.js';

/**
 * `RuleCreator`'s `PluginDocs` generic (`@typescript-eslint/utils`) is how a
 * plugin extends `meta.docs` beyond the base `RuleMetaDataDocs` shape (which
 * only has `description`/`url`/`frozen`) — `requiresTypeChecking` isn't part
 * of that base shape, so it has to be declared here to typecheck at all.
 */
interface PluginDocs {
  /** Standard signal for a type-aware rule (needs `getParserServices`/a real `ts.Program`). */
  requiresTypeChecking: boolean;
}

const createRule = ESLintUtils.RuleCreator<PluginDocs>(
  // README's real anchor for this section is `#eslint-plugin` (a single
  // section covering the whole plugin, not one per-rule anchor) — verified
  // against the actual generated heading rather than guessed.
  () => `https://github.com/walking-wisely/nestjs-swagger-drift/blob/main/README.md#eslint-plugin`,
);

/**
 * The rule's options object, mirroring the CLI's flag surface (PLAN §5 Phase 6)
 * and `AnalysisOptions` (`core/types.ts`) field-for-field, minus `ignoreSuppressions`
 * (see module doc). Every field is optional here — a user only states what
 * they want to override, e.g. `{ maxDepth: 3 }`. `RuleCreator`'s `applyDefault`
 * DOES deep-merge a user's partial object over `DEFAULT_OPTIONS` before
 * `create()` ever sees it (see `RuleCreator.js`'s `applyDefault`/`deepMerge`),
 * so at runtime every field genuinely is present by the time `create()` runs
 * — but `create()` below still reads each field with a `?? DEFAULT_OPTIONS.field`
 * fallback rather than trusting that at the type level: `RuleTester`'s own
 * `ValidTestCase`/`InvalidTestCase` types key `options` off this SAME `Options`
 * type, and a test case (like a real user's config) should be free to specify
 * only the one or two fields it cares about — which only typechecks if
 * `Options` itself stays fully optional throughout.
 */
interface Options {
  /** See `AnalysisOptions.maxDepth`. Default: `2`, matching the CLI's `--max-depth`. */
  maxDepth?: number;
  /** See `AnalysisOptions.rules`. Both opt-in rules default to `false`, matching the CLI. */
  rules?: {
    'documented-but-unreachable'?: boolean;
    'unresolvable-status'?: boolean;
  };
  /** See `AnalysisOptions.treatDefaultAsWildcard`. Default: `false`, matching the CLI. */
  treatDefaultAsWildcard?: boolean;
  /** See `AnalysisOptions.ignoreStatuses`. Default: `[]`. */
  ignoreStatuses?: number[];
  /** See `AnalysisOptions.checkSuccessResponse`. Default: `true` — the one implicit check on by default. */
  checkSuccessResponse?: boolean;
  /** See `AnalysisOptions.checkValidationPipe`. Default: `false`, matching the CLI. */
  checkValidationPipe?: boolean;
  /** See `AnalysisOptions.checkGuards`. Default: `false`, matching the CLI. */
  checkGuards?: boolean;
  /** See `AnalysisOptions.checkParsePipes`. Default: `false`, matching the CLI. */
  checkParsePipes?: boolean;
}

type RuleOptionsTuple = [Options];

type MessageIds = 'undocumentedStatus' | 'documentedButUnreachable' | 'unresolvableStatus';

const DEFAULT_OPTIONS = {
  maxDepth: 2,
  rules: {
    'documented-but-unreachable': false,
    'unresolvable-status': false,
  },
  treatDefaultAsWildcard: false,
  ignoreStatuses: [] as number[],
  checkSuccessResponse: true,
  checkValidationPipe: false,
  checkGuards: false,
  checkParsePipes: false,
} satisfies Options;

/** Handler label shared by all three message templates, e.g. `POST /users (UsersController.create)` — matches `cli/report/pretty.ts`'s wording so the two surfaces read consistently. */
function handlerLabel(handler: Finding['handler']): string {
  return `${handler.httpMethod} ${handler.path} (${handler.className}.${handler.methodName})`;
}

/**
 * Label for the exception(s)/reason(s) behind an `undocumented-status`
 * finding — mirrors `cli/report/pretty.ts`'s `formatFindingPretty` (the
 * `[...new Set(...)]` dedup is intentional there and here: a status reached
 * by both a direct throw and a call-graph throw of the same exception class
 * should list that class once, not twice).
 */
function exceptionsLabel(finding: Extract<Finding, { rule: 'undocumented-status' }>): string {
  const names = [
    ...new Set(finding.sources.map((s) => (s.kind === 'implicit' ? s.reason : s.exception))),
  ];
  return names.join(', ');
}

export const documentedStatusCodesRule = createRule<RuleOptionsTuple, MessageIds>({
  name: 'documented-status-codes',
  meta: {
    type: 'problem',
    docs: {
      description:
        'Every HTTP status code a NestJS handler can produce must be documented with an @ApiResponse-family decorator.',
      // Standard signal for a type-aware rule (needs `getParserServices`/a
      // real `ts.Program`) — see module doc's "Required user configuration".
      requiresTypeChecking: true,
    },
    schema: [
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          maxDepth: { type: 'integer', minimum: 0 },
          rules: {
            type: 'object',
            additionalProperties: false,
            properties: {
              'documented-but-unreachable': { type: 'boolean' },
              'unresolvable-status': { type: 'boolean' },
            },
          },
          treatDefaultAsWildcard: { type: 'boolean' },
          ignoreStatuses: { type: 'array', items: { type: 'integer' } },
          checkSuccessResponse: { type: 'boolean' },
          checkValidationPipe: { type: 'boolean' },
          checkGuards: { type: 'boolean' },
          checkParsePipes: { type: 'boolean' },
        },
      },
    ],
    messages: {
      // Wording mirrors `cli/report/pretty.ts`'s `formatFindingPretty` so a
      // team running both the CLI (e.g. in CI) and this rule (in-editor) sees
      // the same story told two ways, not two different stories.
      undocumentedStatus: '{{handlerLabel}} is missing @ApiResponse for {{status}} ({{exceptions}}).',
      documentedButUnreachable:
        '{{handlerLabel}} documents {{status}}, but nothing in this run produces it (documented-but-unreachable).',
      // `{{what}}` names the SOURCE of the unresolvable status — an
      // unresolvable THROWN status ("a throw") vs. issue #15's unresolvable
      // `@HttpCode` SUCCESS-status argument ("an @HttpCode(...)") — see
      // `Finding`'s `kind` field on the `unresolvable-status` variant. The
      // sentence itself says what failed to resolve ("whose status could not
      // be resolved"), so `{{detail}}` only needs to add the specific reason
      // (adversarial review: the previous "has a throw that could not be
      // resolved" wording was simply wrong — the throw resolved fine, its
      // STATUS didn't — and redundant for the `@HttpCode` case).
      unresolvableStatus:
        '{{handlerLabel}} has {{what}} whose status could not be resolved: {{detail}} (unresolvable-status).',
    },
  },
  defaultOptions: [DEFAULT_OPTIONS],
  create(context, [options]) {
    const services = ESLintUtils.getParserServices(context);

    const analysisOptions: AnalysisOptions = {
      maxDepth: options.maxDepth ?? DEFAULT_OPTIONS.maxDepth,
      rules: {
        'documented-but-unreachable':
          options.rules?.['documented-but-unreachable'] ?? DEFAULT_OPTIONS.rules['documented-but-unreachable'],
        'unresolvable-status': options.rules?.['unresolvable-status'] ?? DEFAULT_OPTIONS.rules['unresolvable-status'],
      },
      treatDefaultAsWildcard: options.treatDefaultAsWildcard ?? DEFAULT_OPTIONS.treatDefaultAsWildcard,
      ignoreStatuses: options.ignoreStatuses ?? DEFAULT_OPTIONS.ignoreStatuses,
      checkSuccessResponse: options.checkSuccessResponse ?? DEFAULT_OPTIONS.checkSuccessResponse,
      checkValidationPipe: options.checkValidationPipe ?? DEFAULT_OPTIONS.checkValidationPipe,
      checkGuards: options.checkGuards ?? DEFAULT_OPTIONS.checkGuards,
      checkParsePipes: options.checkParsePipes ?? DEFAULT_OPTIONS.checkParsePipes,
    };
    // `createAnalysisContext` resolves (or creates) the program-keyed shared
    // cache — see module doc's "no second cache" note. Cheap to call once
    // per visited method; not hoisted out of `create()` because `services`/
    // `services.program` aren't available until `create()` runs.
    const ctx = createAnalysisContext(services.program, analysisOptions);

    /**
     * Anchors a `Finding` at the most precise ESTree node available.
     * `finding.node` is always a `ts.Node` from SOME file that this run's
     * `ts.Program` parsed, but not always the file ESLint is currently
     * linting: `unresolvable-status` (PLAN §5 Phase 5 review) can point at a
     * throw reached through the call graph in a called service's file, and
     * `services.tsNodeToESTreeNodeMap` — like the parser services generally —
     * only has entries for the CURRENT file's AST (PLAN §2.1(2): ESLint
     * rules "can't report into another file"). Falling back to the handler
     * `MethodDefinition` node being visited keeps the finding visible (with
     * the real location still in `finding.node`'s own text, surfaced via
     * `detail`/the message, see `crossFileLocation` below) rather than
     * silently dropping it.
     *
     * `usedFallback` tells the caller whether this actually fell back (vs.
     * the common case of `finding.node` already being in the current file),
     * so `report()` below knows when it's safe to enrich the message with an
     * explicit file:line for the real throw — cheap to compute here since
     * `finding.node` is still the genuine `ts.Node`, but only worth adding to
     * the message when the reported node ISN'T already at that location.
     */
    function reportNodeFor(
      finding: Finding,
      methodNode: TSESTree.MethodDefinition,
    ): { node: TSESTree.Node; usedFallback: boolean } {
      const mapped = services.tsNodeToESTreeNodeMap.get(finding.node);
      return mapped ? { node: mapped, usedFallback: false } : { node: methodNode, usedFallback: true };
    }

    /**
     * `file:line` for `finding.node`'s own location — used only when
     * `reportNodeFor` had to fall back to the handler method node (a
     * cross-file `unresolvable-status`, see above), so the message doesn't
     * lose the actual throw's location the way it otherwise would (m7,
     * Phase 6 review: the CLI's report doesn't have this gap since it prints
     * every hop's own file:line — see `cli/report/pretty.ts` — so this keeps
     * the ESLint surface from silently regressing relative to it).
     */
    function crossFileLocation(node: ts.Node): string {
      const sourceFile = node.getSourceFile();
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      return `${sourceFile.fileName}:${line + 1}`;
    }

    function report(finding: Finding, methodNode: TSESTree.MethodDefinition): void {
      const { node, usedFallback } = reportNodeFor(finding, methodNode);
      const handlerLabelStr = handlerLabel(finding.handler);
      switch (finding.rule) {
        case 'undocumented-status':
          context.report({
            node,
            messageId: 'undocumentedStatus',
            data: {
              handlerLabel: handlerLabelStr,
              status: String(finding.status),
              exceptions: exceptionsLabel(finding),
            },
          });
          return;
        case 'documented-but-unreachable':
          context.report({
            node,
            messageId: 'documentedButUnreachable',
            data: { handlerLabel: handlerLabelStr, status: String(finding.status) },
          });
          return;
        case 'unresolvable-status':
          context.report({
            node,
            messageId: 'unresolvableStatus',
            data: {
              handlerLabel: handlerLabelStr,
              what: finding.unresolvableKind === 'success' ? 'an @HttpCode(...)' : 'a throw',
              detail: usedFallback ? `${finding.detail} (at ${crossFileLocation(finding.node)})` : finding.detail,
            },
          });
      }
    }

    return {
      MethodDefinition(node) {
        const tsNode = services.esTreeNodeToTSNodeMap.get(node);
        // `esTreeNodeToTSNodeMap.get` on a `MethodDefinition` always yields
        // the `ts.MethodDeclaration` it was converted from (verified against
        // `@typescript-eslint/typescript-estree`'s converter: the same
        // `ts.Node` is passed to `createNode` for both the `MethodDefinition`
        // and its inner value expression, and `esTreeNodeToTSNodeMap` is a
        // forward map keyed by the ESTree node, so there's no ambiguity here)
        // — this check is defensive, not expected to ever fail in practice.
        if (!ts.isMethodDeclaration(tsNode)) return;

        // Delegates entirely to `core/analyze.ts` — see module doc's "hard
        // rule" note. `analyzeHandler` itself returns `[]` for a method that
        // isn't an HTTP handler on a `@Controller` class (a constructor, a
        // plain helper method, ...), so no discovery logic is duplicated
        // here either.
        const findings = analyzeHandler(tsNode, ctx);
        for (const finding of findings) report(finding, node);
      },
    };
  },
});
