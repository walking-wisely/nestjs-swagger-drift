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
    case 'implicit': {
      const label = source.detail ? `${source.reason}: ${source.detail}` : source.reason;
      return `implicit (${label})  ${formatLocation(locationOf(source.node, baseDir))}`;
    }
  }
}

/**
 * PLAN §4.4's report shape, extended in Phase 5 for the two opt-in rules
 * `undocumented-status` was previously the only one this function rendered
 * meaningfully.
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

  const { handler } = finding;
  const handlerLabel = `${handler.httpMethod} ${handler.path} (${handler.className}.${handler.methodName})`;
  if (finding.rule === 'documented-but-unreachable') {
    return [
      `${formatLocation(locationOf(finding.node, baseDir))}  error`,
      `  ${handlerLabel} documents ${finding.status}, but nothing in this run produces it (documented-but-unreachable).`,
    ].join('\n');
  }
  // 'unresolvable-status' — `kind` distinguishes an unresolvable THROWN
  // status (the original shape) from issue #15's unresolvable `@HttpCode`
  // SUCCESS-status argument. Earlier wording said "has a throw that could not
  // be resolved" for both — wrong for the throw case (the throw resolved
  // fine; its STATUS didn't) and redundant for the success case ("has a
  // success status that could not be resolved: @HttpCode argument is not a
  // statically resolvable literal"). `{{what}}` now names the SOURCE
  // ("a throw" / "an @HttpCode(...)"), and the sentence itself says what
  // failed to resolve ("whose status could not be resolved"), so `detail`
  // only needs to add the specific reason (adversarial review).
  const what = finding.unresolvableKind === 'success' ? 'an @HttpCode(...)' : 'a throw';
  return [
    `${formatLocation(locationOf(finding.node, baseDir))}  error`,
    `  ${handlerLabel} has ${what} whose status could not be resolved: ${finding.detail} (unresolvable-status).`,
  ].join('\n');
}

export function reportRoutesPretty(handlers: readonly HandlerInfo[]): string {
  return handlers.map(formatHandlerPretty).join('\n');
}

export function reportFindingsPretty(findings: readonly Finding[], baseDir: string): string {
  return findings.map((f) => formatFindingPretty(f, baseDir)).join('\n\n');
}
