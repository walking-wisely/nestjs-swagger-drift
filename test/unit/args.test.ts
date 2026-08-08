import { describe, expect, it } from 'vitest';
import { parseArgs } from '../../src/cli/args.js';

describe('parseArgs', () => {
  it('parses no arguments into all-default flags', () => {
    const result = parseArgs([]);
    expect(result).toEqual({
      ok: true,
      flags: {
        help: false,
        project: undefined,
        routes: false,
        reporter: undefined,
        maxDepth: undefined,
        failOn: undefined,
        ignore: [],
        ignoreStatuses: [],
        enableRules: [],
        disableRules: [],
        treatDefaultAsWildcard: undefined,
        checkSuccessResponse: undefined,
        checkValidationPipe: undefined,
        checkGuards: undefined,
        checkParsePipes: undefined,
        baseDir: undefined,
        config: undefined,
        noConfig: false,
        audit: false,
        fixDryRun: false,
        fix: false,
      },
    });
  });

  it('parses --project and its -p alias', () => {
    const a = parseArgs(['--project', './tsconfig.json']);
    expect(a.ok && a.flags.project).toBe('./tsconfig.json');
    const b = parseArgs(['-p', './tsconfig.json']);
    expect(b.ok && b.flags.project).toBe('./tsconfig.json');
  });

  it('parses --routes and --help', () => {
    const result = parseArgs(['--routes', '--help']);
    expect(result.ok && result.flags.routes).toBe(true);
    expect(result.ok && result.flags.help).toBe(true);
  });

  it('parses a valid --reporter value', () => {
    const result = parseArgs(['--reporter', 'json']);
    expect(result.ok && result.flags.reporter).toBe('json');
  });

  it('rejects an invalid --reporter value', () => {
    const result = parseArgs(['--reporter', 'xml']);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain('--reporter');
  });

  it('parses a valid --max-depth value', () => {
    const result = parseArgs(['--max-depth', '3']);
    expect(result.ok && result.flags.maxDepth).toBe(3);
  });

  it('rejects a non-integer --max-depth', () => {
    const result = parseArgs(['--max-depth', 'two']);
    expect(result.ok).toBe(false);
  });

  it('rejects a negative --max-depth for the right reason (non-vacuous: the message names the actual constraint)', () => {
    // Regression coverage: `-1` used to be mistaken for the *next flag*
    // (`looksLikeFlag('-1')` fires before the value is even parsed as a
    // number), so this failed with "requires a value" — the "must be a
    // non-negative integer" branch below it was unreachable dead code, and
    // the user-facing message was actively wrong about why their input was
    // rejected.
    const result = parseArgs(['--max-depth', '-1']);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain('non-negative integer');
  });

  it('rejects a negative --ignore-status for the same reason', () => {
    const result = parseArgs(['--ignore-status', '-1']);
    expect(result.ok && result.flags.ignoreStatuses).toEqual([-1]);
  });

  it('accepts --max-depth 0', () => {
    const result = parseArgs(['--max-depth', '0']);
    expect(result.ok && result.flags.maxDepth).toBe(0);
  });

  it('parses --fail-on as a raw string, deferring grammar validation to index.ts', () => {
    const result = parseArgs(['--fail-on', 'undocumented-status,unresolvable-status']);
    expect(result.ok && result.flags.failOn).toBe('undocumented-status,unresolvable-status');
  });

  it('collects repeated --ignore into an array, in order', () => {
    const result = parseArgs(['--ignore', 'test/**', '--ignore', '**/*.spec.ts']);
    expect(result.ok && result.flags.ignore).toEqual(['test/**', '**/*.spec.ts']);
  });

  it('collects repeated --ignore-status as numbers', () => {
    const result = parseArgs(['--ignore-status', '500', '--ignore-status', '502']);
    expect(result.ok && result.flags.ignoreStatuses).toEqual([500, 502]);
  });

  it('rejects a non-integer --ignore-status', () => {
    const result = parseArgs(['--ignore-status', 'nope']);
    expect(result.ok).toBe(false);
  });

  it('collects --enable-rule / --disable-rule with a recognized rule name', () => {
    const result = parseArgs([
      '--enable-rule',
      'documented-but-unreachable',
      '--disable-rule',
      'unresolvable-status',
    ]);
    expect(result.ok && result.flags.enableRules).toEqual(['documented-but-unreachable']);
    expect(result.ok && result.flags.disableRules).toEqual(['unresolvable-status']);
  });

  it('rejects --enable-rule with an unrecognized name', () => {
    const result = parseArgs(['--enable-rule', 'undocumented-status']);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain('undocumented-status');
  });

  it('parses --treat-default-as-wildcard and its negation', () => {
    const on = parseArgs(['--treat-default-as-wildcard']);
    expect(on.ok && on.flags.treatDefaultAsWildcard).toBe(true);
    const off = parseArgs(['--no-treat-default-as-wildcard']);
    expect(off.ok && off.flags.treatDefaultAsWildcard).toBe(false);
  });

  it('parses --check-success-response and its negation', () => {
    const on = parseArgs(['--check-success-response']);
    expect(on.ok && on.flags.checkSuccessResponse).toBe(true);
    const off = parseArgs(['--no-check-success-response']);
    expect(off.ok && off.flags.checkSuccessResponse).toBe(false);
  });

  it('parses --check-validation-pipe and its negation', () => {
    const on = parseArgs(['--check-validation-pipe']);
    expect(on.ok && on.flags.checkValidationPipe).toBe(true);
    const off = parseArgs(['--no-check-validation-pipe']);
    expect(off.ok && off.flags.checkValidationPipe).toBe(false);
  });

  it('parses --check-guards and its negation', () => {
    const on = parseArgs(['--check-guards']);
    expect(on.ok && on.flags.checkGuards).toBe(true);
    const off = parseArgs(['--no-check-guards']);
    expect(off.ok && off.flags.checkGuards).toBe(false);
  });

  it('parses --check-parse-pipes and its negation', () => {
    const on = parseArgs(['--check-parse-pipes']);
    expect(on.ok && on.flags.checkParsePipes).toBe(true);
    const off = parseArgs(['--no-check-parse-pipes']);
    expect(off.ok && off.flags.checkParsePipes).toBe(false);
  });

  it('parses --base-dir and --config', () => {
    const result = parseArgs(['--base-dir', '/repo', '--config', './my.config.json']);
    expect(result.ok && result.flags.baseDir).toBe('/repo');
    expect(result.ok && result.flags.config).toBe('./my.config.json');
  });

  it('parses --no-config and --audit', () => {
    const result = parseArgs(['--no-config', '--audit']);
    expect(result.ok && result.flags.noConfig).toBe(true);
    expect(result.ok && result.flags.audit).toBe(true);
  });

  it('rejects an unknown flag rather than silently ignoring it', () => {
    // This is the exact failure mode Phase 4 was asked to close: a typo'd
    // flag must not silently fall through to defaults.
    const result = parseArgs(['--porject', './tsconfig.json']);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain('--porject');
  });

  it('rejects a stray positional argument', () => {
    const result = parseArgs(['--project', './tsconfig.json', 'src/']);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain('src/');
  });

  it('rejects a value-taking flag given at the end of argv with no value', () => {
    const result = parseArgs(['--project']);
    expect(result.ok).toBe(false);
  });

  it('rejects a value-taking flag whose "value" looks like another flag', () => {
    const result = parseArgs(['--project', '--routes']);
    expect(result.ok).toBe(false);
  });
});
