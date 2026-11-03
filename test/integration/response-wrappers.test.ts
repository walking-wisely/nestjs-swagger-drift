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

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/response-wrappers');

function findings(responseDecorators?: AnalysisOptions['responseDecorators']) {
  const outcome = createProgramFromTsConfig(join(FIXTURE_DIR, 'tsconfig.json'));
  if (!outcome.ok) throw new Error('failed to build program for response-wrappers fixture');
  const ctx = createAnalysisContext(outcome.result.program, {
    maxDepth: 3,
    rules: { 'documented-but-unreachable': false, 'unresolvable-status': false },
    treatDefaultAsWildcard: false,
    ignoreStatuses: [],
    checkSuccessResponse: true,
    ...(responseDecorators ? { responseDecorators } : {}),
  });
  return discoverHandlerMethodNodes(outcome.result.program).flatMap((n) => analyzeHandler(n, ctx));
}

function labels(result: ReturnType<typeof findings>): string[] {
  return result
    .map((f) =>
      `${f.handler.className}.${f.handler.methodName} ${f.rule === 'unresolvable-status' ? '' : f.status}`.trim(),
    )
    .sort();
}

const CONFIG = {
  ApiOkResponse: [200],
  ApiNotFoundResponse: [404],
  ApiCommonResponses: [404, 409],
};

describe('response wrapper decorators', () => {
  it('reads ApiResponse from its body but needs configuration for the rest', () => {
    expect(labels(findings())).toEqual(
      [
        'BareController.list 200',
        'BareController.list 409',
        'ItemsController.create 409',
        'ItemsController.find 200',
        'ItemsController.find 404',
        'ItemsController.remove 404',
        'ItemsController.remove 204',
      ].sort(),
    );
  });

  it('clears them with the configured wrappers and keeps the real finding', () => {
    expect(labels(findings(CONFIG))).toEqual([
      'BareController.list 200',
      'BareController.list 409',
      'ItemsController.remove 204',
    ]);
  });

  it('attaches a hint naming the unreadable wrapper when it is not configured', () => {
    const result = findings({ ApiOkResponse: [200], ApiNotFoundResponse: [404] });
    const hinted = result.filter(
      (f) => f.rule === 'undocumented-status' && f.documentationGaps !== undefined,
    );
    expect(hinted.length).toBeGreaterThan(0);
    for (const f of hinted) {
      expect(f.rule === 'undocumented-status' && f.documentationGaps?.[0]?.decorator).toBe(
        'ApiCommonResponses',
      );
    }
  });
});
