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

import {
  findingConfidence,
  traceSource,
  type Finding,
  type DocumentationGap,
  type HandlerInfo,
  type StatusSource,
} from '../../core/index.js';
import { locationOf, type Location } from './location.js';

interface JsonSource {
  kind: StatusSource['kind'];
  exception?: string;
  reason?: string;
  via?: string[];
  detail?: string;
  location: Location;
  trace?: JsonTrace;
}

interface JsonTrace {
  finalArguments: { parameter: string; argument: string }[];
  hops: { name: string; call: string; location: Location }[];
  guards: {
    kind: string;
    condition: string | undefined;
    parameters: string[];
    assessment: string;
    location: Location;
  }[];
}

function traceToJson(source: StatusSource, baseDir: string): JsonTrace | undefined {
  const trace = traceSource(source);
  if (!trace) return undefined;
  return {
    finalArguments: trace.finalArguments,
    hops: trace.hops.map((h) => ({
      name: h.name,
      call: h.call,
      location: locationOf(h.node, baseDir),
    })),
    guards: trace.guards.map((g) => ({
      kind: g.kind,
      condition: g.condition,
      parameters: g.parameters,
      assessment: g.assessment,
      location: locationOf(g.node, baseDir),
    })),
  };
}

function sourceToJson(source: StatusSource, baseDir: string, explain: boolean): JsonSource {
  const json = sourceToJsonBase(source, baseDir);
  const trace = explain ? traceToJson(source, baseDir) : undefined;
  return trace ? { ...json, trace } : json;
}

function sourceToJsonBase(source: StatusSource, baseDir: string): JsonSource {
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
  return JSON.stringify({ handlers: handlers.map((h) => handlerToJson(h, baseDir)) }, undefined, 2);
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
  confidence?: 'low';
  confidenceReasons?: string[];
  documentationGaps?: DocumentationGap[];
}

function findingToJson(finding: Finding, baseDir: string, explain: boolean): JsonFinding {
  const confidence = findingConfidence(finding);
  return {
    rule: finding.rule,
    status: finding.rule === 'unresolvable-status' ? undefined : finding.status,
    handler: handlerToJson(finding.handler, baseDir),
    location: locationOf(finding.node, baseDir),
    sources:
      finding.rule === 'undocumented-status'
        ? finding.sources.map((s) => sourceToJson(s, baseDir, explain))
        : [],
    detail: finding.rule === 'unresolvable-status' ? finding.detail : undefined,
    unresolvableKind: finding.rule === 'unresolvable-status' ? finding.unresolvableKind : undefined,
    ...(confidence.level === 'low'
      ? { confidence: 'low' as const, confidenceReasons: confidence.reasons }
      : {}),
    ...(finding.rule === 'undocumented-status' && finding.documentationGaps
      ? { documentationGaps: finding.documentationGaps }
      : {}),
  };
}

export function reportFindingsJson(
  findings: readonly Finding[],
  baseDir: string,
  failing: readonly Finding[],
  suppressed = 0,
  explain = false,
): string {
  return JSON.stringify(
    {
      findings: findings.map((f) => findingToJson(f, baseDir, explain)),
      summary: { total: findings.length, failing: failing.length, suppressed },
    },
    undefined,
    2,
  );
}
