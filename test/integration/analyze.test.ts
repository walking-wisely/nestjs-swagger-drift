import { describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import * as ts from 'typescript';
import { createProgramFromTsConfig } from '../../src/cli/program.js';
import { discoverHandlerMethodNodes } from '../../src/cli/discover.js';
import { main } from '../../src/cli/index.js';
import {
  analyzeHandler,
  createAnalysisContext,
  type AnalysisOptions,
  type Finding,
} from '../../src/core/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function defaultOptions(): AnalysisOptions {
  return {
    maxDepth: 2,
    rules: { 'documented-but-unreachable': false, 'unresolvable-status': false },
    treatDefaultAsWildcard: false,
    ignoreStatuses: [],
  };
}

interface ExpectedFinding {
  rule: string;
  status: number;
  httpMethod: string;
  path: string;
  className: string;
  methodName: string;
  sources: Array<{ kind: string; exception?: string }>;
}

function serialize(finding: Finding): ExpectedFinding {
  if (finding.rule !== 'undocumented-status') {
    throw new Error(`Phase 2 only produces undocumented-status findings, got ${finding.rule}`);
  }
  return {
    rule: finding.rule,
    status: finding.status,
    httpMethod: finding.handler.httpMethod,
    path: finding.handler.path,
    className: finding.handler.className,
    methodName: finding.handler.methodName,
    sources: finding.sources.map((s) =>
      s.kind === 'implicit' ? { kind: s.kind } : { kind: s.kind, exception: s.exception },
    ),
  };
}

function sortSerialized(findings: ExpectedFinding[]): ExpectedFinding[] {
  return [...findings].sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    if (a.methodName !== b.methodName) return a.methodName < b.methodName ? -1 : 1;
    return a.status - b.status;
  });
}

function analyzeFixture(
  fixtureDir: string,
  options: AnalysisOptions = defaultOptions(),
): Finding[] {
  const outcome = createProgramFromTsConfig(join(fixtureDir, 'tsconfig.json'));
  if (!outcome.ok) throw new Error(`failed to build program for ${fixtureDir}`);
  const ctx = createAnalysisContext(outcome.result.program, options);
  const nodes = discoverHandlerMethodNodes(outcome.result.program);
  return nodes.flatMap((n) => analyzeHandler(n, ctx));
}

describe('analyzeHandler over the status-diff fixture', () => {
  const FIXTURE_DIR = join(__dirname, '../fixtures/status-diff');

  it('produces exactly the expected undocumented-status findings', () => {
    const findings = analyzeFixture(FIXTURE_DIR);
    const actual = sortSerialized(findings.map(serialize));
    const expected: ExpectedFinding[] = JSON.parse(
      readFileSync(join(FIXTURE_DIR, 'expected.json'), 'utf8'),
    );
    expect(actual).toEqual(expected);
  });

  it('finds the undocumented 404 (Phase 2 exit criterion)', () => {
    const findings = analyzeFixture(FIXTURE_DIR);
    const widget = findings.find(
      (f) => f.rule === 'undocumented-status' && f.handler.className === 'UndocumentedController',
    );
    expect(widget).toBeDefined();
    if (widget?.rule === 'undocumented-status') {
      expect(widget.status).toBe(404);
    }
  });

  it('a throw inside a callback produces no finding', () => {
    const findings = analyzeFixture(FIXTURE_DIR);
    expect(findings.some((f) => f.handler.className === 'CallbackThrowController')).toBe(false);
  });

  it('a custom exception class and a dynamic HttpException status both resolve to unknown (no finding)', () => {
    const findings = analyzeFixture(FIXTURE_DIR);
    expect(findings.some((f) => f.handler.className === 'UnresolvableController')).toBe(false);
  });

  it('@ApiDefaultResponse does not suppress findings by default (treatDefaultAsWildcard: false)', () => {
    const findings = analyzeFixture(FIXTURE_DIR);
    expect(findings.some((f) => f.handler.className === 'DefaultWildcardController')).toBe(true);
  });

  it('@ApiDefaultResponse suppresses findings when treatDefaultAsWildcard is enabled', () => {
    const findings = analyzeFixture(FIXTURE_DIR, {
      ...defaultOptions(),
      treatDefaultAsWildcard: true,
    });
    expect(findings.some((f) => f.handler.className === 'DefaultWildcardController')).toBe(false);
    // And must not have suppressed the unrelated genuine finding.
    expect(findings.some((f) => f.handler.className === 'UndocumentedController')).toBe(true);
  });

  it('ignoreStatuses suppresses a specific status code', () => {
    const findings = analyzeFixture(FIXTURE_DIR, { ...defaultOptions(), ignoreStatuses: [404] });
    expect(findings.some((f) => f.rule === 'undocumented-status' && f.status === 404)).toBe(false);
  });

  it('the built CLI exits 1 and prints the undocumented finding', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const code = main(['--project', join(FIXTURE_DIR, 'tsconfig.json')]);
      expect(code).toBe(1);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('404'));
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('the built CLI --routes flag still prints the plain route table and exits 0', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const code = main(['--project', join(FIXTURE_DIR, 'tsconfig.json'), '--routes']);
      expect(code).toBe(0);
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('→ UndocumentedController.findOne'),
      );
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});

describe('analyzeHandler over the no-false-positives corpus', () => {
  const FIXTURE_DIR = join(__dirname, '../fixtures/no-false-positives');

  it('reports exactly nothing', () => {
    const findings = analyzeFixture(FIXTURE_DIR);
    expect(findings).toEqual([]);
  });

  it('the built CLI exits 0 clean', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const code = main(['--project', join(FIXTURE_DIR, 'tsconfig.json')]);
      expect(code).toBe(0);
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});

describe('analyzeHandler is a no-op for non-handler methods', () => {
  it('still returns findings for the real handler in the fixture (sanity baseline)', () => {
    const outcome = createProgramFromTsConfig(
      join(__dirname, '../fixtures/status-diff/tsconfig.json'),
    );
    if (!outcome.ok) throw new Error('failed to build program');
    const ctx = createAnalysisContext(outcome.result.program, defaultOptions());

    const sourceFile = outcome.result.program
      .getSourceFiles()
      .find((sf) => sf.fileName.endsWith('undocumented.controller.ts'));
    if (!sourceFile) throw new Error('fixture file not found');

    // Grab the real handler and confirm `analyzeHandler` still requires
    // `getHandlerInfosForMethod` to recognize it — i.e. this isn't a
    // separate discovery path that could drift from the route table's.
    let method: ts.MethodDeclaration | undefined;
    ts.forEachChild(sourceFile, function visit(node) {
      if (
        ts.isMethodDeclaration(node) &&
        ts.isClassDeclaration(node.parent) &&
        node.parent.name?.text === 'UndocumentedController'
      ) {
        method = node;
      }
      ts.forEachChild(node, visit);
    });
    if (!method) throw new Error('handler method not found');

    expect(analyzeHandler(method, ctx).length).toBeGreaterThan(0);
  });

  it('returns [] for a throwing method on a non-controller class in the same file as a real handler', () => {
    const outcome = createProgramFromTsConfig(
      join(__dirname, '../fixtures/status-diff/tsconfig.json'),
    );
    if (!outcome.ok) throw new Error('failed to build program');
    const ctx = createAnalysisContext(outcome.result.program, defaultOptions());

    const sourceFile = outcome.result.program
      .getSourceFiles()
      .find((sf) => sf.fileName.endsWith('undocumented.controller.ts'));
    if (!sourceFile) throw new Error('fixture file not found');

    // `NotAController` sits in the same file as `UndocumentedController` and
    // has a throwing method that looks handler-shaped syntactically, but
    // isn't decorated with `@Controller`/`@Get` — must produce no findings.
    let method: ts.MethodDeclaration | undefined;
    ts.forEachChild(sourceFile, function visit(node) {
      if (
        ts.isMethodDeclaration(node) &&
        ts.isClassDeclaration(node.parent) &&
        node.parent.name?.text === 'NotAController'
      ) {
        method = node;
      }
      ts.forEachChild(node, visit);
    });
    if (!method) throw new Error('NotAController.findOne not found');

    expect(analyzeHandler(method, ctx)).toEqual([]);
  });
});
