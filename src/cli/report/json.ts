/**
 * `--reporter json`: a single JSON document to stdout, for CI tooling that
 * wants to post-process results rather than parse `pretty.ts`'s text.
 *
 * Unlike the pretty reporter, this NEVER emits a human sentence ("No
 * undocumented status codes found.") in place of structured output — an
 * empty/zero-finding run still prints a well-formed JSON document (`{
 * "findings": [], ... }`), because a JSON consumer that has to special-case
 * "sometimes this is prose instead of JSON" is worse than no JSON reporter
 * at all. Diagnostics, warnings, and usage errors still go to `console.error`
 * as plain text either way (`index.ts`) — only the *result* (routes or
 * findings) is reporter-controlled.
 */

import type { Finding, HandlerInfo, StatusSource } from '../../core/index.js';
import { locationOf, type Location } from './location.js';

interface JsonSource {
  kind: StatusSource['kind'];
  exception?: string;
  reason?: string;
  via?: string[];
  detail?: string;
  location: Location;
}

function sourceToJson(source: StatusSource, baseDir: string): JsonSource {
  const location = locationOf(source.node, baseDir);
  if (source.kind === 'throw') {
    return { kind: source.kind, exception: source.exception, location };
  }
  if (source.kind === 'service-throw') {
    return {
      kind: source.kind,
      exception: source.exception,
      via: source.via.map((hop) => hop.name),
      location,
    };
  }
  return source.detail !== undefined
    ? { kind: source.kind, reason: source.reason, detail: source.detail, location }
    : { kind: source.kind, reason: source.reason, location };
}

interface JsonHandler {
  httpMethod: string;
  path: string;
  unresolvedPath: boolean;
  className: string;
  methodName: string;
  location: Location;
}

function handlerToJson(handler: HandlerInfo, baseDir: string): JsonHandler {
  return {
    httpMethod: handler.httpMethod,
    path: handler.path,
    unresolvedPath: handler.unresolvedPath,
    className: handler.className,
    methodName: handler.methodName,
    location: locationOf(handler.node, baseDir),
  };
}

export function reportRoutesJson(handlers: readonly HandlerInfo[], baseDir: string): string {
  return JSON.stringify(
    { handlers: handlers.map((h) => handlerToJson(h, baseDir)) },
    undefined,
    2,
  );
}

interface JsonFinding {
  rule: Finding['rule'];
  status: number | undefined;
  handler: JsonHandler;
  location: Location;
  sources: JsonSource[];
  detail: string | undefined;
  /**
   * Only set for `rule: 'unresolvable-status'` — a thrown status vs. issue
   * #15's unresolvable `@HttpCode` success argument. Named `unresolvableKind`,
   * not `kind` (adversarial review): `sources[]` entries ALSO carry a `kind`
   * field with a completely different value set
   * (`"throw" | "service-throw" | "implicit"`) — reusing the same JSON key at
   * two nesting levels for two different things is exactly the kind of
   * surprise a machine-readable format shouldn't spring on a consumer.
   */
  unresolvableKind: 'throw' | 'success' | undefined;
}

function findingToJson(finding: Finding, baseDir: string): JsonFinding {
  return {
    rule: finding.rule,
    status: finding.rule === 'unresolvable-status' ? undefined : finding.status,
    handler: handlerToJson(finding.handler, baseDir),
    location: locationOf(finding.node, baseDir),
    sources: finding.rule === 'undocumented-status' ? finding.sources.map((s) => sourceToJson(s, baseDir)) : [],
    detail: finding.rule === 'unresolvable-status' ? finding.detail : undefined,
    unresolvableKind: finding.rule === 'unresolvable-status' ? finding.unresolvableKind : undefined,
  };
}

export function reportFindingsJson(
  findings: readonly Finding[],
  baseDir: string,
  failing: readonly Finding[],
  suppressed = 0,
): string {
  return JSON.stringify(
    {
      findings: findings.map((f) => findingToJson(f, baseDir)),
      summary: { total: findings.length, failing: failing.length, suppressed },
    },
    undefined,
    2,
  );
}
