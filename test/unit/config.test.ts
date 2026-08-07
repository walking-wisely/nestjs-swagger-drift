import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadConfigFile } from '../../src/cli/config.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swagger-drift-config-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('loadConfigFile', () => {
  it('the zero-config path: no config file present returns an empty config, not an error', async () => {
    const dir = makeTempDir();
    const result = await loadConfigFile(undefined, dir);
    expect(result).toEqual({ ok: true, config: {}, path: undefined });
  });

  it('auto-discovers swagger-drift.config.json', async () => {
    const dir = makeTempDir();
    fs.writeFileSync(
      path.join(dir, 'swagger-drift.config.json'),
      JSON.stringify({ maxDepth: 5, reporter: 'json' }),
    );
    const result = await loadConfigFile(undefined, dir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config).toEqual({ maxDepth: 5, reporter: 'json' });
      expect(result.path).toBe(path.join(dir, 'swagger-drift.config.json'));
    }
  });

  it('auto-discovers a .mjs config exporting a default object', async () => {
    const dir = makeTempDir();
    fs.writeFileSync(
      path.join(dir, 'swagger-drift.config.mjs'),
      'export default { maxDepth: 9 };\n',
    );
    const result = await loadConfigFile(undefined, dir);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config).toEqual({ maxDepth: 9 });
  });

  it('auto-discovers a .ts config, transpiling it without a user-provided loader', async () => {
    const dir = makeTempDir();
    fs.writeFileSync(
      path.join(dir, 'swagger-drift.config.ts'),
      'const cfg: { maxDepth: number } = { maxDepth: 4 };\nexport default cfg;\n',
    );
    const result = await loadConfigFile(undefined, dir);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config).toEqual({ maxDepth: 4 });
  });

  it('prefers .json over .mjs/.ts when more than one config file exists', async () => {
    const dir = makeTempDir();
    fs.writeFileSync(
      path.join(dir, 'swagger-drift.config.json'),
      JSON.stringify({ maxDepth: 1 }),
    );
    fs.writeFileSync(path.join(dir, 'swagger-drift.config.mjs'), 'export default { maxDepth: 2 };\n');
    const result = await loadConfigFile(undefined, dir);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config).toEqual({ maxDepth: 1 });
  });

  it('an explicit --config path is loaded even with a nonstandard name', async () => {
    const dir = makeTempDir();
    const explicit = path.join(dir, 'custom.json');
    fs.writeFileSync(explicit, JSON.stringify({ maxDepth: 3 }));
    const result = await loadConfigFile('custom.json', dir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config).toEqual({ maxDepth: 3 });
      expect(result.path).toBe(explicit);
    }
  });

  it('an explicit --config path that does not exist is a clear error, not a silent zero-config fallback', async () => {
    const dir = makeTempDir();
    const result = await loadConfigFile('does-not-exist.json', dir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('does-not-exist.json');
  });

  it('invalid JSON produces a clear error', async () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'swagger-drift.config.json'), '{ not valid json');
    const result = await loadConfigFile(undefined, dir);
    expect(result.ok).toBe(false);
  });

  it('a config module that does not export a plain object is a clear error', async () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'swagger-drift.config.mjs'), 'export default [1, 2, 3];\n');
    const result = await loadConfigFile(undefined, dir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('plain object');
  });

  // Phase 4 review, finding S2: pre-fix, `loadConfigFile` did an unchecked
  // `raw as CliConfigFile` cast — a config file's fields were trusted
  // without validation, unlike the equivalent CLI flags. Each case below is
  // non-vacuous against that specific bug: every one of these would have
  // been silently accepted (or crashed downstream with a raw, unhelpful
  // stack trace) before this fix.
  describe('field validation (Phase 4 review, finding S2)', () => {
    it('rejects an unknown top-level key rather than silently dropping it (a config typo)', async () => {
      const dir = makeTempDir();
      fs.writeFileSync(
        path.join(dir, 'swagger-drift.config.json'),
        JSON.stringify({ iggnore: ['src/**'] }),
      );
      const result = await loadConfigFile(undefined, dir);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('iggnore');
    });

    it('rejects a negative maxDepth, matching --max-depth\'s own validation', async () => {
      const dir = makeTempDir();
      fs.writeFileSync(
        path.join(dir, 'swagger-drift.config.json'),
        JSON.stringify({ maxDepth: -5 }),
      );
      const result = await loadConfigFile(undefined, dir);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('maxDepth');
    });

    it('rejects a non-array "ignore" instead of crashing downstream on patterns.some', async () => {
      const dir = makeTempDir();
      fs.writeFileSync(
        path.join(dir, 'swagger-drift.config.json'),
        JSON.stringify({ ignore: 'src/**' }),
      );
      const result = await loadConfigFile(undefined, dir);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('ignore');
    });

    it('rejects a non-string "project" instead of crashing downstream with ERR_INVALID_ARG_TYPE', async () => {
      const dir = makeTempDir();
      fs.writeFileSync(
        path.join(dir, 'swagger-drift.config.json'),
        JSON.stringify({ project: 42 }),
      );
      const result = await loadConfigFile(undefined, dir);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('project');
    });

    it('rejects a non-boolean "treatDefaultAsWildcard" (a truthy string must not silently mean true)', async () => {
      const dir = makeTempDir();
      fs.writeFileSync(
        path.join(dir, 'swagger-drift.config.json'),
        JSON.stringify({ treatDefaultAsWildcard: 'yes' }),
      );
      const result = await loadConfigFile(undefined, dir);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('treatDefaultAsWildcard');
    });

    it('rejects an unknown "rules" key', async () => {
      const dir = makeTempDir();
      fs.writeFileSync(
        path.join(dir, 'swagger-drift.config.json'),
        JSON.stringify({ rules: { 'not-a-real-rule': true } }),
      );
      const result = await loadConfigFile(undefined, dir);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('not-a-real-rule');
    });

    it('accepts a fully valid config unchanged', async () => {
      const dir = makeTempDir();
      const config = {
        project: './tsconfig.json',
        reporter: 'json',
        maxDepth: 3,
        failOn: 'all',
        ignore: ['src/**'],
        ignoreStatuses: [404],
        rules: { 'documented-but-unreachable': true },
        treatDefaultAsWildcard: true,
        checkSuccessResponse: false,
        checkValidationPipe: true,
        checkGuards: true,
        checkParsePipes: true,
        baseDir: '.',
      };
      fs.writeFileSync(path.join(dir, 'swagger-drift.config.json'), JSON.stringify(config));
      const result = await loadConfigFile(undefined, dir);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.config).toEqual(config);
    });

    it('rejects a non-boolean "checkSuccessResponse"', async () => {
      const dir = makeTempDir();
      fs.writeFileSync(
        path.join(dir, 'swagger-drift.config.json'),
        JSON.stringify({ checkSuccessResponse: 'no' }),
      );
      const result = await loadConfigFile(undefined, dir);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('checkSuccessResponse');
    });

    it('rejects a non-boolean "checkValidationPipe"', async () => {
      const dir = makeTempDir();
      fs.writeFileSync(
        path.join(dir, 'swagger-drift.config.json'),
        JSON.stringify({ checkValidationPipe: 1 }),
      );
      const result = await loadConfigFile(undefined, dir);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('checkValidationPipe');
    });

    it('rejects a non-boolean "checkGuards"', async () => {
      const dir = makeTempDir();
      fs.writeFileSync(
        path.join(dir, 'swagger-drift.config.json'),
        JSON.stringify({ checkGuards: 'on' }),
      );
      const result = await loadConfigFile(undefined, dir);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('checkGuards');
    });

    it('rejects a non-boolean "checkParsePipes"', async () => {
      const dir = makeTempDir();
      fs.writeFileSync(
        path.join(dir, 'swagger-drift.config.json'),
        JSON.stringify({ checkParsePipes: 'on' }),
      );
      const result = await loadConfigFile(undefined, dir);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('checkParsePipes');
    });
  });
});
