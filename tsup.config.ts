import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'core/index': 'src/core/index.ts',
    'cli/index': 'src/cli/index.ts',
    'eslint/index': 'src/eslint/index.ts',
  },
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node20',
  // The `cli` entry + `bin` field was wired up in Phase 1; Phase 4 filled in
  // the full flag surface (`args.ts`, `config.ts`, `report/*`) behind it
  // without needing any build-config changes here.
});
