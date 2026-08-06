/**
 * `nestjs-swagger-drift/eslint` — the ESLint plugin (PLAN §5 Phase 6).
 *
 * Shipped from the SAME package as the CLI and `./core` (PLAN §1: "Ship 1+2
 * as a single package initially ... Split only when the ESLint plugin
 * lands." — §9's open decision, "Lean: single package until Phase 6," points
 * at the SAME moment: splitting once Phase 6 (this plugin) lands, not
 * deferring past it. This Phase 6 change keeps the plugin as a subpath
 * export for now rather than splitting immediately, matching `./core`'s
 * existing pattern in `package.json`'s `exports` field, rather than becoming
 * its own `eslint-plugin-nestjs-swagger-drift` package — revisit the split
 * per PLAN §9 if that becomes worth doing).
 *
 * Flat config only (ESLint 9+ / this repo's own `eslint.config.js` style) —
 * no `.eslintrc` legacy-config export. One rule:
 * `nestjs-swagger-drift/documented-status-codes`
 * (`rules/documented-status-codes.ts`), which is a pure adapter over
 * `core/analyze.ts`'s `analyzeHandler()` — see that file's module doc for the
 * full adapter design.
 *
 * `@typescript-eslint/utils` (`ESLintUtils.RuleCreator`/`getParserServices`,
 * used only by `rules/documented-status-codes.ts`) is an optional
 * `peerDependency` here, NOT a hard `dependency`: this package's CLI
 * (`nestjs-swagger-drift`, the zero-config binary most users install) never
 * imports `./eslint` and shouldn't pull in `@typescript-eslint/utils`'s
 * transitive tree just to sit unused. Anyone actually wiring up
 * `./eslint` in a flat config already has `typescript-eslint`-family
 * packages installed (a type-aware ESLint rule is meaningless without them),
 * so the peer is satisfied for free in every real consumer; `eslint` itself
 * is handled the same way, for the same reason, just above.
 *
 * ## Usage
 *
 * ```js
 * // eslint.config.js
 * import nestjsSwaggerDrift from 'nestjs-swagger-drift/eslint';
 *
 * export default [
 *   // ...your other config (must already configure type-aware
 *   // typescript-eslint parsing for your .ts files — see below)...
 *   {
 *     languageOptions: {
 *       parserOptions: {
 *         // Required: this rule is type-aware (PLAN §2.1(1)) — it needs a
 *         // real ts.Program to resolve service calls across files, exactly
 *         // like any other type-aware typescript-eslint rule.
 *         projectService: true,
 *         tsconfigRootDir: import.meta.dirname,
 *       },
 *     },
 *   },
 *   // `configs.recommended` is an ARRAY of flat-config objects (the same
 *   // shape typescript-eslint's own `tseslint.configs.recommended` uses) —
 *   // spread it at the ARRAY level, into the exported config array itself,
 *   // never into a single object literal: `{ ...configs.recommended }` on an
 *   // array produces `{'0': {...}}`, which ESLint's flat-config loader
 *   // rejects with `ConfigError: Unexpected key "0" found.`
 *   ...nestjsSwaggerDrift.configs.recommended,
 * ];
 * ```
 *
 * `configs.recommended` only supplies the `plugins` registration, the rule's
 * default severity (`'error'`), and a `files` scope limiting itself to
 * `**\/*.ts`/`.tsx`/`.mts`/`.cts` (so it's inert on non-TS files instead of
 * calling `getParserServices` — which requires a type-aware parser — on every
 * file in the project, e.g. the user's own `eslint.config.js`). It
 * deliberately does NOT set `languageOptions`/`parserOptions` itself (a
 * plugin config reaching into a user's parser setup is surprising and hard to
 * override cleanly); the `projectService`/`project` requirement — a
 * prerequisite `configs.recommended` does NOT bundle — stays the user's own
 * config, spelled out here and in the README.
 */

import type { TSESLint } from '@typescript-eslint/utils';
import { documentedStatusCodesRule } from './rules/documented-status-codes.js';

const rules = {
  'documented-status-codes': documentedStatusCodesRule,
} satisfies Record<string, TSESLint.RuleModule<string, unknown[]>>;

/**
 * Kept in sync with `package.json`'s `version` by hand (there is no build
 * step here that reads it) — this package is `"private": true` and not yet
 * published (PLAN §5's exit criterion, "v0.1.0 published to npm", hadn't
 * fired as of Phase 6), so a stale meta version has no user-facing
 * consequence yet; revisit if that changes.
 */
const PLUGIN_VERSION = '0.0.0';

interface NestjsSwaggerDriftPlugin extends TSESLint.FlatConfig.Plugin {
  configs: {
    recommended: TSESLint.FlatConfig.ConfigArray;
  };
}

const plugin: NestjsSwaggerDriftPlugin = {
  meta: { name: 'nestjs-swagger-drift', version: PLUGIN_VERSION },
  rules,
  configs: {
    // Populated just below — a config referencing the plugin object needs
    // the plugin object to exist first, so this starts empty and gets
    // assigned once `plugin` itself is in scope (the same
    // build-then-patch-`configs`-in shape used across the typescript-eslint/
    // eslint-plugin ecosystem, since a config's `plugins` entry has to point
    // back at this very object).
    recommended: [],
  },
};

plugin.configs.recommended = [
  {
    // Per flat-config convention (and matching typescript-eslint's own named
    // configs) so this doesn't show up as `Config (unnamed)` in ESLint
    // output/errors.
    name: 'nestjs-swagger-drift/recommended',
    // Scoped to TS files only: the rule unconditionally calls
    // `getParserServices` in `create()`, which throws on any file parsed by
    // a non-type-aware (or non-TS) parser. Without this `files` scope,
    // spreading `configs.recommended` into a project-wide config array would
    // crash the moment ESLint reaches a non-type-aware file, e.g. the user's
    // own `eslint.config.js` (mirrors typescript-eslint's own
    // `recommendedTypeChecked`-style configs, which scope the same way).
    files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'],
    plugins: { 'nestjs-swagger-drift': plugin },
    rules: {
      'nestjs-swagger-drift/documented-status-codes': 'error',
    },
  },
];

export default plugin;
