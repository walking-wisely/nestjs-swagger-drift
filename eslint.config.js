// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    // test/fixtures/** are analysis *input*: no @nestjs/* installed, need
    // experimentalDecorators, and deliberately contain wrong/broken code.
    // They're excluded from tsconfig.json's project too (see B2/B3 review
    // note) — without this, typescript-eslint's projectService hard-fails
    // parsing every fixture file instead of just skipping it.
    ignores: ['dist/**', 'coverage/**', 'node_modules/**', 'test/fixtures/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['*.js', '*.ts'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // PLAN.md §3 hard rule: `core/` is a pure engine — it must not import
    // from `cli/` or `eslint/`, and must not touch process/fs/console or any
    // other Node built-in. This is a guard rail, not a sandbox: it does not
    // (and cannot, with static rules alone) catch dynamic `import()`.
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/cli/**', '**/cli', '**/eslint/**', '**/eslint'],
              message: 'core/ must not import from cli/ or eslint/ (see PLAN.md §3).',
            },
            {
              group: [
                'node:*',
                'fs',
                'fs/promises',
                'path',
                'os',
                'child_process',
                'process',
                'url',
              ],
              message: 'core/ must be Node-free (see PLAN.md §3).',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'process', message: 'core/ must not touch process (see PLAN.md §3).' },
        { name: 'console', message: 'core/ must not touch console (see PLAN.md §3).' },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'globalThis',
          property: 'process',
          message: 'core/ must not touch process (see PLAN.md §3).',
        },
        {
          object: 'globalThis',
          property: 'console',
          message: 'core/ must not touch console (see PLAN.md §3).',
        },
      ],
    },
  },
  eslintConfigPrettier,
);
