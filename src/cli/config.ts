/**
 * Optional `swagger-drift.config.{json,js,mjs,ts}` (PLAN.md §5 Phase 4).
 * CLI-only (PLAN §3) — this is the one place, besides `program.ts`, allowed
 * to touch `fs`/`path`/dynamic `import()` on core's behalf.
 *
 * The zero-config path is load-bearing (PLAN's explicit requirement): when
 * no config file exists, `loadConfigFile` returns an empty config and
 * `path: undefined` rather than an error — every field is then supplied by
 * CLI flags and `index.ts`'s built-in defaults, exactly as before this file
 * existed.
 *
 * Every field here mirrors a CLI flag 1:1 (see `args.ts`), and precedence is
 * CLI flag > config file > built-in default — decided in `index.ts`'s
 * `mergeOptions`, not here; this module's only job is producing a
 * `CliConfigFile` (or a clear error) from whatever's on disk.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { pathToFileURL } from 'node:url';
import * as ts from 'typescript';

export interface CliConfigFile {
  project?: string;
  reporter?: string;
  maxDepth?: number;
  /** Same grammar as `--fail-on` (see `args.ts`): `'all'`, `'none'`, or a comma list of rule names. */
  failOn?: string;
  ignore?: string[];
  ignoreStatuses?: number[];
  rules?: Partial<Record<'documented-but-unreachable' | 'unresolvable-status', boolean>>;
  treatDefaultAsWildcard?: boolean;
  baseDir?: string;
}

export type ConfigLoadResult =
  | { ok: true; config: CliConfigFile; path: string | undefined }
  | { ok: false; error: string };

// PLAN.md §5 Phase 4 only asks for `.{ts,json}`; `.mjs`/`.js` are additional
// scope, kept deliberately rather than dropped: `.ts` support already goes
// through `loadTsConfigModule`'s transpile-to-a-temp-file dance below, so
// the marginal cost of also accepting a config that's already plain
// JS/ESM — no transpile step needed, just `import()` it — is one constant
// added to this list, and it's the format a config generator (or a user
// who doesn't want TS in their config) would reach for first. `test/unit/
// config.test.ts` covers `.mjs` explicitly, so this isn't dead surface.
const CONFIG_BASENAMES = [
  'swagger-drift.config.json',
  'swagger-drift.config.mjs',
  'swagger-drift.config.js',
  'swagger-drift.config.ts',
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const CONFIG_KEYS = new Set<string>([
  'project',
  'reporter',
  'maxDepth',
  'failOn',
  'ignore',
  'ignoreStatuses',
  'rules',
  'treatDefaultAsWildcard',
  'baseDir',
]);

const RULE_KEYS = new Set<string>(['documented-but-unreachable', 'unresolvable-status']);

/**
 * Validates and narrows `raw` (whatever a config file exported) into a
 * `CliConfigFile`, field by field, against the same shape `args.ts` enforces
 * for the equivalent CLI flag. Pre-Phase-4-review, this was an unchecked
 * `raw as CliConfigFile` cast — a config file was trusted more than the
 * command line: `{"maxDepth": -5}` silently produced `EXIT_OK` on a repo
 * `--max-depth -5` correctly rejects as a usage error, and a typo'd key
 * (`{"iggnore": [...]}`) was silently dropped, the exact "don't swallow a
 * typo" failure mode `args.ts`'s own doc comment calls out. Every known key
 * is validated here; any *unknown* key is a hard error too, for the same
 * reason.
 */
function validateConfig(
  raw: Record<string, unknown>,
  sourcePath: string,
): { ok: true; config: CliConfigFile } | { ok: false; error: string } {
  const unknownKeys = Object.keys(raw).filter((k) => !CONFIG_KEYS.has(k));
  if (unknownKeys.length > 0) {
    return {
      ok: false,
      error: `${sourcePath}: unknown config key(s): ${unknownKeys.join(', ')}`,
    };
  }

  function fail(field: string, expected: string, value: unknown): { ok: false; error: string } {
    return {
      ok: false,
      error: `${sourcePath}: "${field}" must be ${expected}, got ${JSON.stringify(value)}`,
    };
  }

  const config: CliConfigFile = {};

  if ('project' in raw) {
    const value = raw['project'];
    if (typeof value !== 'string') return fail('project', 'a string', value);
    config.project = value;
  }

  if ('reporter' in raw) {
    const value = raw['reporter'];
    if (value !== 'pretty' && value !== 'json') {
      return fail('reporter', '"pretty" or "json"', value);
    }
    config.reporter = value;
  }

  if ('maxDepth' in raw) {
    const value = raw['maxDepth'];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      return fail('maxDepth', 'a non-negative integer', value);
    }
    config.maxDepth = value;
  }

  if ('failOn' in raw) {
    const value = raw['failOn'];
    if (typeof value !== 'string') return fail('failOn', 'a string', value);
    config.failOn = value;
  }

  if ('ignore' in raw) {
    const value = raw['ignore'];
    if (!Array.isArray(value) || value.some((p) => typeof p !== 'string')) {
      return fail('ignore', 'an array of strings', value);
    }
    config.ignore = value as string[];
  }

  if ('ignoreStatuses' in raw) {
    const value = raw['ignoreStatuses'];
    if (!Array.isArray(value) || value.some((n) => typeof n !== 'number' || !Number.isInteger(n))) {
      return fail('ignoreStatuses', 'an array of integers', value);
    }
    config.ignoreStatuses = value as number[];
  }

  if ('rules' in raw) {
    const value = raw['rules'];
    if (!isPlainObject(value)) return fail('rules', 'an object', value);
    const unknownRuleKeys = Object.keys(value).filter((k) => !RULE_KEYS.has(k));
    if (unknownRuleKeys.length > 0) {
      return {
        ok: false,
        error: `${sourcePath}: unknown "rules" key(s): ${unknownRuleKeys.join(', ')}`,
      };
    }
    for (const [key, ruleValue] of Object.entries(value)) {
      if (typeof ruleValue !== 'boolean') return fail(`rules.${key}`, 'a boolean', ruleValue);
    }
    config.rules = value as Partial<Record<'documented-but-unreachable' | 'unresolvable-status', boolean>>;
  }

  if ('treatDefaultAsWildcard' in raw) {
    const value = raw['treatDefaultAsWildcard'];
    if (typeof value !== 'boolean') {
      return fail('treatDefaultAsWildcard', 'a boolean', value);
    }
    config.treatDefaultAsWildcard = value;
  }

  if ('baseDir' in raw) {
    const value = raw['baseDir'];
    if (typeof value !== 'string') return fail('baseDir', 'a string', value);
    config.baseDir = value;
  }

  return { ok: true, config };
}

/**
 * Loads a `.js`/`.mjs` config module and returns its config object: whatever
 * was `export default`ed, or (for `module.exports = {...}`-style CJS
 * transpiled to an ESM default) the module namespace itself minus its
 * `default`/`__esModule` bookkeeping keys — accepting both keeps a config
 * file boring to write regardless of which module style the author reaches
 * for.
 */
async function importConfigModule(fileUrl: string): Promise<unknown> {
  const mod: unknown = await import(fileUrl);
  if (isPlainObject(mod) && 'default' in mod) return mod['default'];
  return mod;
}

/**
 * `.ts` config support without asking users to have a TS loader configured:
 * transpile with the `typescript` package we already depend on (a peer dep,
 * but always present at CLI runtime since building the analyzed project's
 * own `ts.Program` requires it), write the JS to a throwaway temp file next
 * to nothing the user owns, import it, then best-effort clean up. This is
 * the same trick several other TS-aware CLIs use to avoid depending on
 * `tsx`/`ts-node` for the one file that's config, not analysis input.
 */
async function loadTsConfigModule(configPath: string): Promise<unknown> {
  const source = fs.readFileSync(configPath, 'utf8');
  const { outputText, diagnostics } = ts.transpileModule(source, {
    fileName: configPath,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
    },
    reportDiagnostics: true,
  });
  const fatal = (diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (fatal.length > 0) {
    const message = ts.formatDiagnostics(fatal, {
      getCurrentDirectory: () => path.dirname(configPath),
      getCanonicalFileName: (f) => f,
      getNewLine: () => '\n',
    });
    throw new Error(`failed to transpile ${configPath}:\n${message}`);
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swagger-drift-config-'));
  const tempFile = path.join(tempDir, 'swagger-drift.config.mjs');
  try {
    fs.writeFileSync(tempFile, outputText, 'utf8');
    return await importConfigModule(pathToFileURL(tempFile).href);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * Resolves and loads a config file. `explicitPath`, when given (`--config`),
 * must exist — a typo'd `--config` path is a usage error, never silently
 * ignored (same "don't ignore what looks like a mistake" bar as unknown
 * flags — see `args.ts`). Without `explicitPath`, auto-discovers one of
 * `CONFIG_BASENAMES` in `cwd`, first match wins, and returns an empty config
 * with `path: undefined` if none exists — the zero-config path.
 */
export async function loadConfigFile(
  explicitPath: string | undefined,
  cwd: string,
): Promise<ConfigLoadResult> {
  let resolvedPath: string | undefined;

  if (explicitPath !== undefined) {
    const candidate = path.resolve(cwd, explicitPath);
    if (!fs.existsSync(candidate)) {
      return { ok: false, error: `config file not found: ${candidate}` };
    }
    resolvedPath = candidate;
  } else {
    for (const basename of CONFIG_BASENAMES) {
      const candidate = path.join(cwd, basename);
      if (fs.existsSync(candidate)) {
        resolvedPath = candidate;
        break;
      }
    }
  }

  if (resolvedPath === undefined) {
    return { ok: true, config: {}, path: undefined };
  }

  try {
    let raw: unknown;
    if (resolvedPath.endsWith('.json')) {
      raw = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
    } else if (resolvedPath.endsWith('.ts')) {
      raw = await loadTsConfigModule(resolvedPath);
    } else {
      raw = await importConfigModule(pathToFileURL(resolvedPath).href);
    }

    if (!isPlainObject(raw)) {
      return {
        ok: false,
        error: `${resolvedPath} must export a plain object (got ${typeof raw}).`,
      };
    }
    const validated = validateConfig(raw, resolvedPath);
    if (!validated.ok) return validated;
    return { ok: true, config: validated.config, path: resolvedPath };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `failed to load ${resolvedPath}: ${message}` };
  }
}
