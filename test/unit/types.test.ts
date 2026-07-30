import { describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import type { Finding, HandlerInfo, StatusSource } from '../../src/index.js';

describe('core types', () => {
  it('shapes a Finding around a HandlerInfo and its StatusSources', () => {
    const sourceFile = ts.createSourceFile(
      'fixture.ts',
      'export class UsersController {}',
      ts.ScriptTarget.Latest,
    );
    const node: ts.Node = sourceFile;

    const handler: HandlerInfo = {
      className: 'UsersController',
      methodName: 'create',
      httpMethod: 'POST',
      classPath: 'users',
      methodPath: '',
      path: '/users',
      node,
    };

    const sources: StatusSource[] = [
      { kind: 'throw', node, exception: 'ConflictException' },
      {
        kind: 'service-throw',
        node,
        exception: 'NotFoundException',
        via: [{ name: 'UsersService.create', node }],
      },
    ];

    const finding: Finding = {
      rule: 'undocumented-status',
      status: 409,
      handler,
      sources,
      node,
    };

    expect(finding.rule).toBe('undocumented-status');
    expect(finding.handler.className).toBe('UsersController');
    expect(finding.handler.path).toBe('/users');
    expect(finding.sources).toHaveLength(2);
    expect(finding.sources.map((s) => s.kind)).toEqual(['throw', 'service-throw']);

    const serviceThrow = finding.sources[1];
    if (serviceThrow?.kind === 'service-throw') {
      expect(serviceThrow.via).toEqual([{ name: 'UsersService.create', node }]);
    } else {
      throw new Error('expected sources[1] to be a service-throw');
    }
  });
});
