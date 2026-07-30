#!/usr/bin/env node
/**
 * Minimal Phase 1 CLI entry: `--project <tsconfig>` in, a sorted route table
 * out. Full flag surface (reporters, `--fail-on`, config file, `--strict`,
 * ...) is PLAN.md Phase 4 — deliberately not built here. The `strict`
 * plumbing already threaded through `discoverHandlers`/core is there so
 * Phase 4 only has to add a flag, not new wiring.
 */

import * as ts from 'typescript';
import { pathToFileURL } from 'node:url';
import { createProgramFromTsConfig } from './program.js';
import { collectDiscoveryWarnings, discoverHandlers } from './discover.js';
import type { HandlerInfo } from '../core/index.js';

function printUsage(): void {
  console.log('Usage: nestjs-swagger-drift --project <path-to-tsconfig-or-dir>');
}

/**
 * "The setup is broken, nothing could be checked" — distinct from `0`
 * ("checked, found nothing to report") and reserved from whatever exit code
 * Phase 4's `--fail-on` assigns to "found drift" once that exists. See the
 * exit-code policy comment where this is used, in `main()`.
 */
export const EXIT_COULD_NOT_ANALYSE = 2;

function formatDiagnostics(diagnostics: ts.Diagnostic[]): string {
  return ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCurrentDirectory: () => process.cwd(),
    getCanonicalFileName: (f) => f,
    getNewLine: () => '\n',
  });
}

/**
 * Stable sort by path, then HTTP method, then class/method name — the order
 * printed by the CLI and asserted against in
 * `test/integration/discover.test.ts`. Exported so that test asserts against
 * the CLI's real ordering rather than re-implementing it.
 */
export function sortHandlers(handlers: HandlerInfo[]): HandlerInfo[] {
  return [...handlers].sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    if (a.httpMethod !== b.httpMethod) return a.httpMethod < b.httpMethod ? -1 : 1;
    if (a.className !== b.className) return a.className < b.className ? -1 : 1;
    return a.methodName < b.methodName ? -1 : a.methodName > b.methodName ? 1 : 0;
  });
}

function formatHandler(handler: HandlerInfo): string {
  // A path built from an unresolved segment (a template interpolation, a
  // non-literal const, ...) is a best-effort guess, not fact — marking it
  // rather than printing it plainly, per the Phase 1 review (B1): silently
  // wrong routes are worse than visibly incomplete ones, since every later
  // finding is reported through this same path.
  const path = handler.unresolvedPath ? `${handler.path} <unresolved>` : handler.path;
  return `${handler.httpMethod} ${path} → ${handler.className}.${handler.methodName}`;
}

function parseArgs(argv: string[]): { project?: string } {
  const result: { project?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--project' || arg === '-p') {
      const value = argv[i + 1];
      if (value !== undefined) result.project = value;
      i++;
    }
  }
  return result;
}

export function main(argv: string[]): number {
  const args = parseArgs(argv);
  if (!args.project) {
    printUsage();
    return 1;
  }

  const outcome = createProgramFromTsConfig(args.project);
  if (!outcome.ok) {
    switch (outcome.error.kind) {
      case 'config-not-found':
        console.error(
          `nestjs-swagger-drift: could not find a tsconfig at ${outcome.error.configPath}`,
        );
        break;
      case 'config-read-error':
        console.error(
          `nestjs-swagger-drift: failed to read ${outcome.error.configPath}: ${outcome.error.message}`,
        );
        break;
      case 'config-parse-error':
        console.error(`nestjs-swagger-drift: failed to parse ${outcome.error.configPath}:`);
        console.error(formatDiagnostics(outcome.error.diagnostics));
        break;
    }
    return 1;
  }

  const { program, configDiagnostics } = outcome.result;
  if (configDiagnostics.length > 0) {
    console.error(formatDiagnostics(configDiagnostics));
  }

  // B2: silence here is exactly the failure mode a CI tool must not have —
  // an unresolved `@nestjs/common` or a rejected same-named decorator must
  // never look identical to "this repo genuinely has no controllers".
  const warnings = collectDiscoveryWarnings(program);
  for (const warning of warnings) {
    console.error(`nestjs-swagger-drift: warning: ${warning.message}`);
  }

  const handlers = sortHandlers(discoverHandlers(program));
  if (handlers.length === 0) {
    // Exit code policy (Phase 1 review, follow-up): a zero-route result
    // reached because `@nestjs/common` itself couldn't be resolved is a
    // different outcome from a zero-route result reached by successfully
    // checking a repo that genuinely has no controllers — the plan's whole
    // premise is CI trustworthiness, and collapsing "couldn't analyse" into
    // the same exit code as "analysed, found nothing" is precisely the
    // silent-green failure this tool exists to prevent. `EXIT_COULD_NOT_ANALYSE`
    // (2) is reserved for that case and is deliberately distinct from the
    // future Phase 4 "found drift" exit code, which hasn't been assigned yet
    // and isn't built here — Phase 4 owns the general `--fail-on` surface.
    const couldNotAnalyse = warnings.some((w) => w.kind === 'unresolved-module');
    if (couldNotAnalyse) {
      console.error(
        'nestjs-swagger-drift: could not analyse — @nestjs/common could not be resolved for ' +
          'this tsconfig (see warnings above), so this result does not mean "no controllers found."',
      );
      return EXIT_COULD_NOT_ANALYSE;
    }
    console.log('No @Controller handlers found.');
    return 0;
  }

  for (const handler of handlers) {
    console.log(formatHandler(handler));
  }

  return 0;
}

/* c8 ignore start -- exercised via the built CLI binary, not unit tests */
const entryUrl = process.argv[1] === undefined ? undefined : pathToFileURL(process.argv[1]).href;
if (import.meta.url === entryUrl) {
  process.exit(main(process.argv.slice(2)));
}
/* c8 ignore stop */
