/**
 * Consumes `configs.recommended` (`src/eslint/index.ts`) the way a real
 * user's flat config actually would — via `array`-level spread into an
 * `eslint.config.js`-shaped config array, exactly as documented in the
 * README and the module's own doc comment.
 *
 * This is the test that was missing when B1/B2 (Phase 6 adversarial review)
 * shipped: nothing in the original suite ever constructed a `Linter`/config
 * array from `configs.recommended` itself, so two real bugs sailed through:
 *
 * - B1: `configs.recommended` is an ARRAY (matching typescript-eslint's own
 *   `tseslint.configs.recommended` shape); spreading it into a single object
 *   literal — the shape the README used to show — silently produces
 *   `{'0': {...}}`, which ESLint's flat-config loader rejects with
 *   `ConfigError: Unexpected key "0" found.`
 * - B2: `configs.recommended` had no `files` scoping, so applying it
 *   project-wide crashed the instant ESLint reached a non-type-aware file
 *   (e.g. the user's own `eslint.config.js`), since the rule unconditionally
 *   calls `getParserServices` in `create()`.
 */

import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { Linter } from 'eslint';
import tsParser from '@typescript-eslint/parser';
import nestjsSwaggerDriftEslint from '../../src/eslint/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATUS_DIFF_DIR = join(__dirname, '../fixtures/status-diff');

/**
 * Exactly the README's/module doc's documented usage: the user's own
 * `languageOptions`/`parserOptions` config object, followed by
 * `...configs.recommended` spread at the ARRAY level (not into an object
 * literal — see module doc comment for why that distinction matters).
 */
function realUserConfig(tsconfigRootDir: string): Linter.Config[] {
  return [
    {
      languageOptions: {
        parser: tsParser,
        parserOptions: {
          project: './tsconfig.json',
          tsconfigRootDir,
          ecmaVersion: 'latest',
          sourceType: 'module',
        },
      },
    },
    // eslint's own `Linter.Config[]` and `TSESLint.FlatConfig.ConfigArray`
    // disagree just enough under `exactOptionalPropertyTypes` for `tsc` to
    // reject a direct spread here — see the equivalence test's identical
    // cast note for why this is type-only friction, not a runtime mismatch.
    ...(nestjsSwaggerDriftEslint.configs.recommended as unknown as Linter.Config[]),
  ];
}

describe('configs.recommended consumed the way a real eslint.config.js would', () => {
  it('lints a fixture file without crashing and finds the expected undocumented status', () => {
    const linter = new Linter();
    const code = readFileSync(join(STATUS_DIFF_DIR, 'src/undocumented.controller.ts'), 'utf8');

    const messages = linter.verify(code, realUserConfig(STATUS_DIFF_DIR), {
      filename: join(STATUS_DIFF_DIR, 'src/undocumented.controller.ts'),
    });

    // Would have thrown `ConfigError: Unexpected key "0" found.` (B1) before
    // reaching this point at all if `configs.recommended` were still spread
    // wrong; a non-empty, non-crashing result proves the array-level spread
    // documented above actually works end to end.
    expect(messages.some((m) => m.messageId === 'undocumentedStatus')).toBe(true);
  });

  it('is inert (does not crash) on a file outside its `files` scope, e.g. a plain .js config file', () => {
    const linter = new Linter();
    // No `languageOptions`/parser wired up at all here — deliberately
    // mimicking a plain, non-type-aware file elsewhere in a real project
    // (the user's own `eslint.config.js`, a `.js` script, ...). Before B2's
    // fix, `configs.recommended` had no `files` scope, so the rule would run
    // on this file too and crash inside `getParserServices` (which requires
    // a type-aware parser it has no way to get here).
    const messages = linter.verify(
      'module.exports = { foo: 1 };\n',
      nestjsSwaggerDriftEslint.configs.recommended as unknown as Linter.Config[],
      { filename: 'eslint.config.js' },
    );

    expect(messages).toEqual([]);
  });

  it('configs.recommended carries a `name` per flat-config convention (m9)', () => {
    for (const config of nestjsSwaggerDriftEslint.configs.recommended) {
      expect(config.name).toBeTruthy();
    }
  });
});
