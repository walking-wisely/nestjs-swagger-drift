import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createProgramFromTsConfig } from '../../src/cli/program.js';
import { discoverHandlerMethodNodes } from '../../src/cli/discover.js';
import { analyzeHandler, createAnalysisContext } from '../../src/core/index.js';

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/excluded-from-docs');

function flagged(): string[] {
  const outcome = createProgramFromTsConfig(join(FIXTURE_DIR, 'tsconfig.json'));
  if (!outcome.ok) throw new Error('failed to build program for excluded-from-docs fixture');
  const ctx = createAnalysisContext(outcome.result.program, {
    maxDepth: 2,
    rules: { 'documented-but-unreachable': false, 'unresolvable-status': false },
    treatDefaultAsWildcard: false,
    ignoreStatuses: [],
  });
  return discoverHandlerMethodNodes(outcome.result.program)
    .flatMap((n) => analyzeHandler(n, ctx))
    .map((f) => `${f.handler.className}.${f.handler.methodName}`)
    .sort();
}

describe('handlers excluded from the OpenAPI document', () => {
  it('skips @ApiExcludeController classes and @ApiExcludeEndpoint methods', () => {
    expect(flagged()).toEqual(['MixedController.list', 'ShownController.list']);
  });
});
