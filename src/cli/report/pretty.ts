/**
 * The default, human-readable reporter (PLAN §4.4's sample output shape).
 * `--reporter pretty` (the default) uses this; `report/json.ts` is the
 * machine-readable alternative for CI tooling that wants to post-process
 * results rather than parse text.
 */

import type { Finding, HandlerInfo, StatusSource } from '../../core/index.js';
import { formatLocation, locationOf } from './location.js';

export function formatHandlerPretty(handler: HandlerInfo): string {
  // A path built from an unresolved segment (a template interpolation, a
  // non-literal const, ...) is a best-effort guess, not fact — marking it
  // rather than printing it plainly, per the Phase 1 review (B1): silently
  // wrong routes are worse than visibly incomplete ones, since every later
  // finding is reported through this same path.
  const path = handler.unresolvedPath ? `${handler.path} <unresolved>` : handler.path;
  return `${handler.httpMethod} ${path} → ${handler.className}.${handler.methodName}`;
}

/** Label for a `StatusSource`, for the `└ ...` report line under each status. */
function describeSourcePretty(source: StatusSource, baseDir: string): string {
  switch (source.kind) {
    case 'throw':
      return `direct throw  ${formatLocation(locationOf(source.node, baseDir))}`;
    case 'service-throw':
      return `${source.via.map((hop) => hop.name).join(' → ')}  ${formatLocation(locationOf(source.node, baseDir))}`;
    case 'implicit':
      return `implicit (${source.reason})  ${formatLocation(locationOf(source.node, baseDir))}`;
  }
}

/**
 * PLAN §4.4's report shape. `undocumented-status` is the only rule Phase 2–3
 * actually produce; `documented-but-unreachable`/`unresolvable-status` are
 * opt-in and unimplemented (Phase 5), but this switches on `rule` so a
 * future rule can't silently print nothing.
 */
export function formatFindingPretty(finding: Finding, baseDir: string): string {
  if (finding.rule === 'undocumented-status') {
    const { handler, status, sources } = finding;
    const exceptionNames = [
      ...new Set(sources.map((s) => (s.kind === 'implicit' ? s.reason : s.exception))),
    ];
    const lines = [
      `${formatLocation(locationOf(handler.node, baseDir))}  error`,
      `  ${handler.httpMethod} ${handler.path} (${handler.className}.${handler.methodName}) is missing @ApiResponse for:`,
      `    ${status} ${exceptionNames.join(', ')}`,
      ...sources.map((s) => `       └ ${describeSourcePretty(s, baseDir)}`),
    ];
    return lines.join('\n');
  }
  // `documented-but-unreachable` / `unresolvable-status`: opt-in, unimplemented before Phase 5.
  return `${formatLocation(locationOf(finding.node, baseDir))}  error  ${finding.rule}`;
}

export function reportRoutesPretty(handlers: readonly HandlerInfo[]): string {
  return handlers.map(formatHandlerPretty).join('\n');
}

export function reportFindingsPretty(findings: readonly Finding[], baseDir: string): string {
  return findings.map((f) => formatFindingPretty(f, baseDir)).join('\n\n');
}
