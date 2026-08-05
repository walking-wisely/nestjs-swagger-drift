import { afterEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  EXIT_COULD_NOT_ANALYSE,
  EXIT_FOUND_DRIFT,
  EXIT_OK,
  EXIT_USAGE_ERROR,
  main,
  mergeOptions,
} from '../../src/cli/index.js';
import { parseArgs } from '../../src/cli/args.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATUS_DIFF = join(__dirname, '../fixtures/status-diff');
const NO_FALSE_POSITIVES = join(__dirname, '../fixtures/no-false-positives');
const UNRESOLVED_MODULE = join(__dirname, '../fixtures/unresolved-module');
const SUPPRESS_IGNORE = join(__dirname, '../fixtures/suppress-ignore');

function captureConsole() {
  const logs: string[] = [];
  const errors: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((msg: string) => {
    logs.push(msg);
  });
  const errorSpy = vi.spyOn(console, 'error').mockImplementation((msg: string) => {
    errors.push(msg);
  });
  return {
    logs,
    errors,
    restore: () => {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    },
  };
}

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swagger-drift-cli-test-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('--reporter json', () => {
  it('produces a parseable JSON document with the expected shape', async () => {
    const console_ = captureConsole();
    try {
      const code = await main([
        '--project',
        join(STATUS_DIFF, 'tsconfig.json'),
        '--reporter',
        'json',
      ]);
      expect(code).toBe(EXIT_FOUND_DRIFT);
      expect(console_.logs).toHaveLength(1);
      const parsed = JSON.parse(console_.logs[0] ?? '');
      expect(Array.isArray(parsed.findings)).toBe(true);
      expect(parsed.findings.length).toBeGreaterThan(0);
      expect(parsed.summary.total).toBe(parsed.findings.length);
      expect(parsed.summary.failing).toBe(parsed.findings.length);
      const first = parsed.findings[0];
      expect(first).toMatchObject({ rule: 'undocumented-status' });
      expect(typeof first.status).toBe('number');
      expect(first.handler).toMatchObject({ className: expect.any(String) });
      expect(first.location).toMatchObject({ file: expect.any(String), line: expect.any(Number) });
    } finally {
      console_.restore();
    }
  });

  it('still emits a well-formed JSON document (not a prose sentence) when there is nothing to report', async () => {
    const console_ = captureConsole();
    try {
      const code = await main([
        '--project',
        join(NO_FALSE_POSITIVES, 'tsconfig.json'),
        '--reporter',
        'json',
      ]);
      expect(code).toBe(EXIT_OK);
      const parsed = JSON.parse(console_.logs[0] ?? '');
      expect(parsed).toEqual({ findings: [], summary: { total: 0, failing: 0, suppressed: 0 } });
    } finally {
      console_.restore();
    }
  });

  it('--routes --reporter json produces a parseable handler list', async () => {
    const console_ = captureConsole();
    try {
      const code = await main([
        '--project',
        join(STATUS_DIFF, 'tsconfig.json'),
        '--routes',
        '--reporter',
        'json',
      ]);
      expect(code).toBe(EXIT_OK);
      const parsed = JSON.parse(console_.logs[0] ?? '');
      expect(Array.isArray(parsed.handlers)).toBe(true);
      expect(parsed.handlers.length).toBeGreaterThan(0);
    } finally {
      console_.restore();
    }
  });
});

describe('base directory (the Phase 4 bug fix)', () => {
  it('defaults to the tsconfig\'s own directory, not process.cwd()', async () => {
    // Regression coverage for `src/cli/index.ts:262`'s pre-Phase-4 bug: this
    // test's own cwd (wherever `vitest` happens to run from — the repo
    // root) is NOT the fixture's tsconfig directory, so if `baseDir` were
    // still `process.cwd()`, the printed path would be prefixed with
    // `test/fixtures/status-diff/` instead of starting at `src/`.
    expect(process.cwd()).not.toBe(STATUS_DIFF);

    const console_ = captureConsole();
    try {
      const code = await main([
        '--project',
        join(STATUS_DIFF, 'tsconfig.json'),
        '--reporter',
        'json',
      ]);
      expect(code).toBe(EXIT_FOUND_DRIFT);
      const parsed = JSON.parse(console_.logs[0] ?? '');
      const undocumented = parsed.findings.find(
        (f: { handler: { className: string } }) => f.handler.className === 'UndocumentedController',
      );
      expect(undocumented).toBeDefined();
      expect(undocumented.location.file).toBe('src/undocumented.controller.ts');
    } finally {
      console_.restore();
    }
  });

  it('--base-dir overrides the default', async () => {
    const console_ = captureConsole();
    try {
      const code = await main([
        '--project',
        join(STATUS_DIFF, 'tsconfig.json'),
        '--reporter',
        'json',
        '--base-dir',
        join(__dirname, '..', '..'),
      ]);
      expect(code).toBe(EXIT_FOUND_DRIFT);
      const parsed = JSON.parse(console_.logs[0] ?? '');
      const undocumented = parsed.findings.find(
        (f: { handler: { className: string } }) => f.handler.className === 'UndocumentedController',
      );
      expect(undocumented.location.file).toBe(
        'test/fixtures/status-diff/src/undocumented.controller.ts',
      );
    } finally {
      console_.restore();
    }
  });
});

describe('--fail-on', () => {
  it('"none" reports findings but exits EXIT_OK', async () => {
    const console_ = captureConsole();
    try {
      const code = await main([
        '--project',
        join(STATUS_DIFF, 'tsconfig.json'),
        '--reporter',
        'json',
        '--fail-on',
        'none',
      ]);
      expect(code).toBe(EXIT_OK);
      const parsed = JSON.parse(console_.logs[0] ?? '');
      expect(parsed.summary.total).toBeGreaterThan(0);
      expect(parsed.summary.failing).toBe(0);
    } finally {
      console_.restore();
    }
  });

  it('a rule list that does not include undocumented-status exits EXIT_OK even with findings', async () => {
    const console_ = captureConsole();
    try {
      const code = await main([
        '--project',
        join(STATUS_DIFF, 'tsconfig.json'),
        '--reporter',
        'json',
        '--fail-on',
        'unresolvable-status',
      ]);
      expect(code).toBe(EXIT_OK);
      const parsed = JSON.parse(console_.logs[0] ?? '');
      expect(parsed.summary.total).toBeGreaterThan(0);
      expect(parsed.summary.failing).toBe(0);
    } finally {
      console_.restore();
    }
  });

  it('a malformed --fail-on value is a usage error', async () => {
    const console_ = captureConsole();
    try {
      const code = await main([
        '--project',
        join(STATUS_DIFF, 'tsconfig.json'),
        '--fail-on',
        'not-a-real-rule',
      ]);
      expect(code).toBe(EXIT_USAGE_ERROR);
    } finally {
      console_.restore();
    }
  });
});

describe('--ignore', () => {
  it('excludes matching files from both discovery and findings', async () => {
    const console_ = captureConsole();
    try {
      const code = await main([
        '--project',
        join(STATUS_DIFF, 'tsconfig.json'),
        '--reporter',
        'json',
        '--ignore',
        '**/undocumented.controller.ts',
      ]);
      expect(code).toBe(EXIT_FOUND_DRIFT); // other genuine findings remain
      const parsed = JSON.parse(console_.logs[0] ?? '');
      expect(
        parsed.findings.some(
          (f: { handler: { className: string } }) =>
            f.handler.className === 'UndocumentedController',
        ),
      ).toBe(false);
      // Non-vacuous: without --ignore this same fixture DOES report it (see
      // the "the built CLI exits EXIT_FOUND_DRIFT" test in analyze.test.ts).
      expect(parsed.findings.length).toBeGreaterThan(0);
    } finally {
      console_.restore();
    }
  });

  it('reports a distinct message (and EXIT_OK) when --ignore excludes every handler', async () => {
    const console_ = captureConsole();
    try {
      const code = await main([
        '--project',
        join(UNRESOLVED_MODULE, 'tsconfig.json'),
        '--ignore',
        '**/*.controller.ts',
      ]);
      expect(code).toBe(EXIT_OK);
      expect(console_.logs.some((l) => l.includes('excluded by --ignore'))).toBe(true);
    } finally {
      console_.restore();
    }
  });
});

describe('--ignore-status', () => {
  it('maps onto AnalysisOptions.ignoreStatuses', async () => {
    const console_ = captureConsole();
    try {
      const code = await main([
        '--project',
        join(STATUS_DIFF, 'tsconfig.json'),
        '--reporter',
        'json',
        '--ignore-status',
        '404',
      ]);
      const parsed = JSON.parse(console_.logs[0] ?? '');
      // Non-vacuous (Phase 4 review, finding S10): the fixture has several
      // genuine 404 findings AND several non-404 findings, so this fails if
      // `--ignore-status` suppressed nothing (a stray 404 would survive) OR
      // if it suppressed everything (mutation-tested: a broken
      // implementation that drops every finding once *any* status is
      // ignored used to pass this suite with a bare `f.status !== 404`
      // check over an empty array and an `EXIT_FOUND_DRIFT || EXIT_OK`
      // assertion that's true either way).
      expect(parsed.findings.length).toBeGreaterThan(0);
      expect(parsed.findings.every((f: { status: number }) => f.status !== 404)).toBe(true);
      expect(code).toBe(EXIT_FOUND_DRIFT);
    } finally {
      console_.restore();
    }
  });
});

describe('unknown/malformed flags', () => {
  it('a typo\'d flag is a usage error, not a silent no-op', async () => {
    const console_ = captureConsole();
    try {
      const code = await main(['--porject', join(STATUS_DIFF, 'tsconfig.json')]);
      expect(code).toBe(EXIT_USAGE_ERROR);
    } finally {
      console_.restore();
    }
  });

  it('missing --project is a usage error when no config file supplies one', async () => {
    // Deliberately doesn't `process.chdir()` — that throws inside vitest's
    // default worker-thread pool ("process.chdir() is not supported in
    // workers") and would make this test itself unreliable. The repo root
    // (this suite's real `cwd`) has no `swagger-drift.config.*` of its own,
    // which is enough to exercise "neither a flag nor a config file
    // supplied --project" without touching global process state.
    const console_ = captureConsole();
    try {
      const code = await main([]);
      expect(code).toBe(EXIT_USAGE_ERROR);
    } finally {
      console_.restore();
    }
  });
});

describe('--config and swagger-drift.config.json', () => {
  it('an explicit --config file supplies --project, overridable by an explicit flag', async () => {
    const dir = makeTempDir();
    const configPath = path.join(dir, 'my.config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({ project: join(NO_FALSE_POSITIVES, 'tsconfig.json') }),
    );
    const console_ = captureConsole();
    try {
      // No --project on the command line at all — it must come from the config.
      const code = await main(['--config', configPath, '--reporter', 'json']);
      expect(code).toBe(EXIT_OK);
    } finally {
      console_.restore();
    }
  });

  it('an explicit CLI flag overrides the same option in the config file', async () => {
    const dir = makeTempDir();
    const configPath = path.join(dir, 'my.config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({ project: join(NO_FALSE_POSITIVES, 'tsconfig.json'), reporter: 'pretty' }),
    );
    const console_ = captureConsole();
    try {
      const code = await main(['--config', configPath, '--reporter', 'json']);
      expect(code).toBe(EXIT_OK);
      // If the config's "pretty" had won, this wouldn't be parseable JSON.
      expect(() => JSON.parse(console_.logs[0] ?? '')).not.toThrow();
    } finally {
      console_.restore();
    }
  });

  it('a nonexistent --config path is a usage error', async () => {
    const console_ = captureConsole();
    try {
      const code = await main(['--config', '/does/not/exist.json']);
      expect(code).toBe(EXIT_USAGE_ERROR);
    } finally {
      console_.restore();
    }
  });

  it('prints the discovered config path to stderr', async () => {
    // Deliberately doesn't `process.chdir()` (see the "missing --project"
    // test above for why) — an explicit `--config` path exercises the exact
    // same "a config was loaded, print where from" code path as
    // auto-discovery does.
    const dir = makeTempDir();
    const configPath = path.join(dir, 'my.config.json');
    fs.writeFileSync(configPath, JSON.stringify({ project: join(NO_FALSE_POSITIVES, 'tsconfig.json') }));
    const console_ = captureConsole();
    try {
      const code = await main(['--config', configPath]);
      expect(code).toBe(EXIT_OK);
      expect(console_.errors.some((l) => l.includes(configPath))).toBe(true);
    } finally {
      console_.restore();
    }
  });

  it('a config with an unknown key is a clear usage error, not a silently-dropped typo', async () => {
    const dir = makeTempDir();
    const configPath = path.join(dir, 'my.config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({ project: join(NO_FALSE_POSITIVES, 'tsconfig.json'), iggnore: ['src/**'] }),
    );
    const console_ = captureConsole();
    try {
      const code = await main(['--config', configPath]);
      expect(code).toBe(EXIT_USAGE_ERROR);
      expect(console_.errors.some((l) => l.includes('iggnore'))).toBe(true);
    } finally {
      console_.restore();
    }
  });

  it('a relative "project" in a config file resolves against the CONFIG FILE\'s directory, not cwd (Phase 4 review, finding S9)', async () => {
    const dir = makeTempDir();
    const configPath = path.join(dir, 'swagger-drift.config.json');
    // Relative to `dir` (the config file's own directory), not to
    // `process.cwd()` (wherever this test suite happens to run from — the
    // repo root, not `dir`).
    const relativeProject = path.relative(dir, join(NO_FALSE_POSITIVES, 'tsconfig.json'));
    expect(process.cwd()).not.toBe(dir);
    fs.writeFileSync(configPath, JSON.stringify({ project: relativeProject }));
    const console_ = captureConsole();
    try {
      const code = await main(['--config', configPath]);
      expect(code).toBe(EXIT_OK);
    } finally {
      console_.restore();
    }
  });

  it('a relative "baseDir" in a config file resolves against the config file\'s directory (Phase 4 review, finding S9)', async () => {
    const dir = makeTempDir();
    const configPath = path.join(dir, 'swagger-drift.config.json');
    const relativeBaseDir = path.relative(dir, join(__dirname, '..', '..'));
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        project: join(STATUS_DIFF, 'tsconfig.json'),
        reporter: 'json',
        baseDir: relativeBaseDir,
      }),
    );
    const console_ = captureConsole();
    try {
      const code = await main(['--config', configPath]);
      expect(code).toBe(EXIT_FOUND_DRIFT);
      const parsed = JSON.parse(console_.logs[0] ?? '');
      const undocumented = parsed.findings.find(
        (f: { handler: { className: string } }) => f.handler.className === 'UndocumentedController',
      );
      // If `baseDir` had resolved against `process.cwd()` instead, this
      // would either be a different (wrong) relative path or, depending on
      // cwd, an absolute one.
      expect(undocumented.location.file).toBe(
        'test/fixtures/status-diff/src/undocumented.controller.ts',
      );
    } finally {
      console_.restore();
    }
  });

  it('a config with an invalid field value (negative maxDepth) is a usage error, matching --max-depth', async () => {
    const dir = makeTempDir();
    const configPath = path.join(dir, 'my.config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({ project: join(STATUS_DIFF, 'tsconfig.json'), maxDepth: -5 }),
    );
    const console_ = captureConsole();
    try {
      const code = await main(['--config', configPath]);
      // Non-vacuous per Phase 4 review finding S2: pre-fix, this was an
      // unchecked cast and returned EXIT_FOUND_DRIFT (or worse, silently
      // different results) rather than rejecting the malformed config the
      // same way `--max-depth -5` on the command line already does.
      expect(code).toBe(EXIT_USAGE_ERROR);
      expect(console_.errors.some((l) => l.includes('maxDepth'))).toBe(true);
    } finally {
      console_.restore();
    }
  });
});

describe('--no-config', () => {
  // Auto-discovery itself is scanned from `process.cwd()` inside `main()`
  // (not injectable), and this suite deliberately avoids `process.chdir()`
  // (see the "missing --project" test above — it throws inside vitest's
  // default worker-thread pool). `--no-config`'s "skip auto-discovery"
  // behavior is exercised at the `loadConfigFile`/`main()` wiring level
  // instead: combined with `--config`, given an explicit `--project`, and
  // as the thing that makes `--config` + `--no-config` together a clear
  // usage error rather than one silently winning.
  it('--no-config combined with --config is a usage error', async () => {
    const console_ = captureConsole();
    try {
      const code = await main(['--no-config', '--config', './whatever.json']);
      expect(code).toBe(EXIT_USAGE_ERROR);
    } finally {
      console_.restore();
    }
  });

  it('--no-config never prints a "using config file" line, even with an explicit --project', async () => {
    const console_ = captureConsole();
    try {
      const code = await main([
        '--no-config',
        '--project',
        join(NO_FALSE_POSITIVES, 'tsconfig.json'),
      ]);
      expect(code).toBe(EXIT_OK);
      expect(console_.errors.some((l) => l.includes('using config file'))).toBe(false);
    } finally {
      console_.restore();
    }
  });
});

describe('--audit', () => {
  it('reports a suppressed finding that a normal run hides', async () => {
    const console_ = captureConsole();
    try {
      const code = await main([
        '--project',
        join(STATUS_DIFF, 'tsconfig.json'),
        '--reporter',
        'json',
        '--audit',
      ]);
      expect(code).toBe(EXIT_FOUND_DRIFT);
      const parsed = JSON.parse(console_.logs[0] ?? '');
      // `SuppressedController`'s 404 is silenced by a directive in the
      // normal run (see the analyze.test.ts suppression test); --audit must
      // surface it anyway.
      expect(
        parsed.findings.some(
          (f: { handler: { className: string }; status: number }) =>
            f.handler.className === 'SuppressedController' && f.status === 404,
        ),
      ).toBe(true);
    } finally {
      console_.restore();
    }
  });
});

describe('suppression observability (Phase 4 review, finding S6)', () => {
  it('the JSON summary reports how many findings were suppressed', async () => {
    const console_ = captureConsole();
    try {
      const code = await main([
        '--project',
        join(STATUS_DIFF, 'tsconfig.json'),
        '--reporter',
        'json',
      ]);
      expect(code).toBe(EXIT_FOUND_DRIFT);
      const parsed = JSON.parse(console_.logs[0] ?? '');
      // Non-vacuous: SuppressedController's 404 is suppressed by a directive
      // in the fixture (analyze.test.ts asserts on the same fixture), so
      // this is >= 1, not just "the field exists and is 0."
      expect(parsed.summary.suppressed).toBeGreaterThan(0);
    } finally {
      console_.restore();
    }
  });
});

describe('unused-directive warning respects --ignore', () => {
  // Bug report: the "did this directive suppress anything?" scan
  // (`cli/index.ts`, ~588) walked every source file in the program
  // unconditionally, never applying `options.ignore` — so `--ignore`ing a
  // file that still carries a real, working suppression directive produced
  // a false-positive "did not suppress anything" warning. The
  // `suppress-ignore` fixture has three cases: a directly-`--ignore`d file
  // with a real directive (`ignored-direct.controller.ts`), a shared
  // service's real directive reached only via an `--ignore`d controller's
  // call graph (`shared.service.ts`, via `call-graph-caller.controller.ts`),
  // and a genuinely unused directive in a file that's never ignored
  // (`typo.controller.ts`, whose directive names the wrong status) — so the
  // fix's scope is provably narrow, not a blanket suppression of the
  // warning.
  it('warns only about the genuine typo when the other two files are --ignore-d', async () => {
    const console_ = captureConsole();
    try {
      await main([
        '--project',
        join(SUPPRESS_IGNORE, 'tsconfig.json'),
        '--ignore',
        '**/ignored-direct.controller.ts',
        '--ignore',
        '**/call-graph-caller.controller.ts',
        '--reporter',
        'json',
      ]);
      const unusedWarnings = console_.errors.filter((e) => e.includes('did not suppress anything'));
      expect(unusedWarnings).toEqual([
        expect.stringContaining('typo.controller.ts:12 did not suppress anything.'),
      ]);
    } finally {
      console_.restore();
    }
  });

  it('warns about the same typo, and nothing else, when nothing is --ignore-d', async () => {
    // Baseline for the test above: without `--ignore`, every directive in
    // this fixture is either genuinely used (suppresses something) or
    // genuinely unused (the typo) — confirming the warning already
    // discriminates correctly before `--ignore` enters the picture, so the
    // `--ignore` test isn't vacuously passing because the warning never
    // fires on this fixture either way.
    const console_ = captureConsole();
    try {
      await main(['--project', join(SUPPRESS_IGNORE, 'tsconfig.json'), '--reporter', 'json']);
      const unusedWarnings = console_.errors.filter((e) => e.includes('did not suppress anything'));
      expect(unusedWarnings).toEqual([
        expect.stringContaining('typo.controller.ts:12 did not suppress anything.'),
      ]);
    } finally {
      console_.restore();
    }
  });
});

describe('--enable-rule / --disable-rule', () => {
  it('flags default to both opt-in rules disabled (no change to Phase 2/3 default output)', async () => {
    const console_ = captureConsole();
    try {
      const code = await main([
        '--project',
        join(NO_FALSE_POSITIVES, 'tsconfig.json'),
        '--reporter',
        'json',
      ]);
      expect(code).toBe(EXIT_OK);
    } finally {
      console_.restore();
    }
  });

  // Phase 4 review, finding S11: this `describe` block's only test never
  // actually passed either flag, so neither flag's effect on
  // `AnalysisOptions.rules` was exercised anywhere — a parser that silently
  // dropped `--enable-rule`/`--disable-rule` on the floor would still pass
  // the whole suite. `analyzeHandler` doesn't consult `rules` yet (Phase 5,
  // PLAN §4.1c), so `mergeOptions` — where the flags actually land — is the
  // right (and currently only) place to assert this non-vacuously.
  it('--enable-rule/--disable-rule actually reach AnalysisOptions.rules via mergeOptions', () => {
    const base = parseArgs([]);
    if (!base.ok) throw new Error('parseArgs([]) unexpectedly failed');

    const defaultMerge = mergeOptions(base.flags, {}, undefined);
    expect(defaultMerge.ok && defaultMerge.options.rules).toEqual({
      'documented-but-unreachable': false,
      'unresolvable-status': false,
    });

    const enabled = parseArgs(['--enable-rule', 'documented-but-unreachable']);
    if (!enabled.ok) throw new Error('unexpected parse failure');
    const enabledMerge = mergeOptions(enabled.flags, {}, undefined);
    expect(enabledMerge.ok && enabledMerge.options.rules).toEqual({
      'documented-but-unreachable': true,
      'unresolvable-status': false,
    });

    const disabled = parseArgs(['--disable-rule', 'unresolvable-status']);
    if (!disabled.ok) throw new Error('unexpected parse failure');
    // A config file can enable a rule; an explicit `--disable-rule` on the
    // command line must still win (flag > config, same precedence as every
    // other option).
    const disabledMerge = mergeOptions(disabled.flags, {
      rules: { 'unresolvable-status': true },
    }, undefined);
    expect(disabledMerge.ok && disabledMerge.options.rules).toEqual({
      'documented-but-unreachable': false,
      'unresolvable-status': false,
    });
  });
});

describe('EXIT_COULD_NOT_ANALYSE is unaffected by Phase 4 changes', () => {
  it('still returns 2 for the unresolved-module-empty fixture', async () => {
    const console_ = captureConsole();
    try {
      const code = await main([
        '--project',
        join(__dirname, '../fixtures/unresolved-module-empty/tsconfig.json'),
      ]);
      expect(code).toBe(EXIT_COULD_NOT_ANALYSE);
    } finally {
      console_.restore();
    }
  });
});

describe('--help', () => {
  it('prints usage and exits EXIT_OK without requiring --project', async () => {
    const console_ = captureConsole();
    try {
      const code = await main(['--help']);
      expect(code).toBe(EXIT_OK);
      expect(console_.logs.some((l) => l.includes('Usage:'))).toBe(true);
    } finally {
      console_.restore();
    }
  });
});
