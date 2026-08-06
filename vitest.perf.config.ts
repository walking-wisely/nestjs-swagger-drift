import { defineConfig } from 'vitest/config';

// Separate from `vitest.config.ts` deliberately (PLAN §5's perf pass): the
// 500-file synthetic project this benchmark generates and analyzes makes it
// slow enough that it shouldn't run on every `npm test`. `npm run test:perf`
// points at this config explicitly.
export default defineConfig({
  test: {
    include: ['test/perf/**/*.bench.ts'],
    environment: 'node',
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
