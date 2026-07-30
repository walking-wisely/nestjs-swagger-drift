/**
 * tsconfig discovery → `ts.Program` construction.
 *
 * This file is CLI-only (PLAN.md §3): it's the one place allowed to touch
 * `fs`/`path` on core's behalf. Everything it produces (a `ts.Program`) is
 * plain data handed into the pure `core/` functions.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';

export interface ProgramResult {
  program: ts.Program;
  /** Non-fatal config diagnostics (e.g. unknown compilerOptions keys). */
  configDiagnostics: ts.Diagnostic[];
}

export type ProgramError =
  | { kind: 'config-not-found'; configPath: string }
  | { kind: 'config-read-error'; configPath: string; message: string }
  | { kind: 'config-parse-error'; configPath: string; diagnostics: ts.Diagnostic[] };

/**
 * Resolves a tsconfig path (file or containing directory) the way `tsc
 * --project` does, reads and parses it, and builds a `ts.Program` from the
 * resulting file list and compiler options.
 *
 * Returns a discriminated result rather than throwing, so `cli/index.ts` can
 * report config errors cleanly instead of an uncaught exception.
 */
export function createProgramFromTsConfig(
  projectPath: string,
): { ok: true; result: ProgramResult } | { ok: false; error: ProgramError } {
  const cwd = process.cwd();
  const resolved = path.resolve(cwd, projectPath);

  let configPath: string | undefined;
  if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
    configPath = ts.findConfigFile(resolved, ts.sys.fileExists, 'tsconfig.json');
  } else if (fs.existsSync(resolved)) {
    configPath = resolved;
  }

  if (configPath === undefined) {
    return { ok: false, error: { kind: 'config-not-found', configPath: resolved } };
  }

  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) {
    return {
      ok: false,
      error: {
        kind: 'config-read-error',
        configPath,
        message: ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n'),
      },
    };
  }

  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    path.dirname(configPath),
    undefined,
    configPath,
  );

  const fatalDiagnostics = parsed.errors.filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (fatalDiagnostics.length > 0 && parsed.fileNames.length === 0) {
    return {
      ok: false,
      error: { kind: 'config-parse-error', configPath, diagnostics: fatalDiagnostics },
    };
  }

  const program = ts.createProgram(
    parsed.projectReferences === undefined
      ? { rootNames: parsed.fileNames, options: parsed.options }
      : {
          rootNames: parsed.fileNames,
          options: parsed.options,
          projectReferences: parsed.projectReferences,
        },
  );

  return { ok: true, result: { program, configDiagnostics: parsed.errors } };
}
