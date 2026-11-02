import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createProgramFromTsConfig } from '../../src/cli/program.js';
import { discoverHandlerMethodNodes } from '../../src/cli/discover.js';
import {
  analyzeHandler,
  createAnalysisContext,
  type AnalysisOptions,
} from '../../src/core/index.js';

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/guard-guarantees');

function undocumentedErrors(guardGuarantees?: AnalysisOptions['guardGuarantees']): string[] {
  const outcome = createProgramFromTsConfig(join(FIXTURE_DIR, 'tsconfig.json'));
  if (!outcome.ok) throw new Error('failed to build program for guard-guarantees fixture');
  const ctx = createAnalysisContext(outcome.result.program, {
    maxDepth: 3,
    rules: { 'documented-but-unreachable': false, 'unresolvable-status': false },
    treatDefaultAsWildcard: false,
    ignoreStatuses: [],
    checkSuccessResponse: false,
    ...(guardGuarantees ? { guardGuarantees } : {}),
  });
  return discoverHandlerMethodNodes(outcome.result.program)
    .flatMap((n) => analyzeHandler(n, ctx))
    .map((f) =>
      `${f.handler.className}.${f.handler.methodName} ${f.rule === 'unresolvable-status' ? '' : f.status}`.trim(),
    )
    .sort();
}

describe('guardGuarantees', () => {
  it('reports the service-level tenant check on every handler by default', () => {
    expect(undocumentedErrors()).toEqual(['GuardedController.list 401', 'OpenController.list 401']);
  });

  it('drops it only where the configured guard is applied', () => {
    expect(undocumentedErrors({ TenantGuard: ['RequestContext.currentTenantId'] })).toEqual([
      'OpenController.list 401',
    ]);
  });
});
