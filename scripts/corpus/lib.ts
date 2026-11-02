import { createHash } from 'node:crypto';

export type Verdict = 'TP' | 'FP' | 'UNCLEAR' | 'UNTRIAGED';

export interface RunLocation {
  file: string;
  line?: number;
}

export interface RunSource {
  kind: string;
  exception?: string;
  reason?: string;
  via?: string[];
  location?: RunLocation;
}

export interface RunFinding {
  rule: string;
  status: number | undefined;
  handler: { className: string; methodName: string; location: RunLocation };
  location?: RunLocation;
  detail?: string | undefined;
  unresolvableKind?: string | undefined;
  sources: RunSource[];
}

export interface VerdictEntry {
  verdict: Verdict;
  key: string;
  basis?: string;
}

export interface VerdictFile {
  pin: string;
  toolVersion: string;
  recordedAt: string;
  entries: Record<string, VerdictEntry>;
}

export interface Delta {
  unchanged: string[];
  added: { fingerprint: string; key: string }[];
  disappeared: { fingerprint: string; key: string; verdict: Verdict }[];
  changed: { key: string; before: string; after: string; verdict: Verdict }[];
}

export function identityKey(f: RunFinding): string {
  const { className, methodName, location } = f.handler;
  return `${location.file}::${className}.${methodName} ${f.rule} ${f.status ?? '-'}`;
}

function sourceSignature(s: RunSource): string {
  return `${s.kind}:${s.exception ?? s.reason ?? ''}:${(s.via ?? []).join('>')}`;
}

export function fingerprint(f: RunFinding): string {
  const sources = f.sources.map(sourceSignature).sort().join('|');
  const { className, methodName, location } = f.handler;
  return createHash('sha1')
    .update(
      [location.file, className, methodName, f.rule, String(f.status ?? ''), sources].join('\0'),
    )
    .digest('hex');
}

export function computeDelta(
  baseline: Record<string, VerdictEntry>,
  findings: readonly RunFinding[],
): Delta {
  const current = new Map<string, string>();
  for (const f of findings) current.set(fingerprint(f), identityKey(f));

  const unchanged: string[] = [];
  const added: Delta['added'] = [];
  for (const [fp, key] of current) {
    if (fp in baseline) unchanged.push(fp);
    else added.push({ fingerprint: fp, key });
  }

  const lost: Delta['disappeared'] = [];
  for (const [fp, entry] of Object.entries(baseline)) {
    if (!current.has(fp)) lost.push({ fingerprint: fp, key: entry.key, verdict: entry.verdict });
  }

  const changed: Delta['changed'] = [];
  const disappeared: Delta['disappeared'] = [];
  const remainingAdded = [...added];
  for (const gone of lost) {
    const idx = remainingAdded.findIndex((a) => a.key === gone.key);
    if (idx === -1) {
      disappeared.push(gone);
      continue;
    }
    const [match] = remainingAdded.splice(idx, 1);
    changed.push({
      key: gone.key,
      before: gone.fingerprint,
      after: match!.fingerprint,
      verdict: gone.verdict,
    });
  }

  return { unchanged, added: remainingAdded, disappeared, changed };
}

export function blockingReasons(delta: Delta): string[] {
  const reasons: string[] = [];
  if (delta.added.length > 0) reasons.push(`${delta.added.length} new finding(s) need triage`);
  if (delta.changed.length > 0)
    reasons.push(`${delta.changed.length} finding(s) changed source set`);
  const lostDetections = delta.disappeared.filter((d) => d.verdict !== 'FP');
  if (lostDetections.length > 0)
    reasons.push(`${lostDetections.length} baseline finding(s) disappeared`);
  return reasons;
}

export function buildVerdictFile(
  pin: string,
  toolVersion: string,
  recordedAt: string,
  findings: readonly RunFinding[],
): VerdictFile {
  const entries: Record<string, VerdictEntry> = {};
  for (const f of findings) entries[fingerprint(f)] = { verdict: 'UNTRIAGED', key: identityKey(f) };
  return { pin, toolVersion, recordedAt, entries };
}

export interface FindingClass {
  id: string;
  count: number;
  files: number;
  callers: number;
  samples: { key: string; fingerprint: string; at: string; sourceAt: string[] }[];
  fingerprints: string[];
}

function sourceClass(s: RunSource): string {
  if (s.kind === 'implicit') return `implicit:${s.reason ?? ''}`;
  const site = s.location === undefined ? '' : `@${at(s.location)}`;
  return `${s.kind}:${s.exception ?? ''}${site}`;
}

export function classId(f: RunFinding): string {
  const status = f.status === undefined ? '-' : String(f.status);
  const shape = [...new Set(f.sources.map(sourceClass))].sort().join(' + ');
  const extra = f.rule === 'unresolvable-status' ? `${f.unresolvableKind ?? ''}` : '';
  return [f.rule, status, extra, shape].filter((part) => part !== '').join(' | ');
}

function at(loc: RunLocation | undefined): string {
  if (!loc) return '';
  return loc.line === undefined ? loc.file : `${loc.file}:${loc.line}`;
}

function callerOf(f: RunFinding): string {
  const via = f.sources.find((src) => src.via !== undefined)?.via;
  if (via === undefined || via.length === 0) return '';
  return via.length >= 2 ? via[via.length - 2]! : via[0]!;
}

function maxDepth(f: RunFinding): number {
  return Math.max(0, ...f.sources.map((src) => src.via?.length ?? 0));
}

function pickSamples(members: readonly RunFinding[], n: number): RunFinding[] {
  const byCaller = new Map<string, RunFinding>();
  for (const m of members) if (!byCaller.has(callerOf(m))) byCaller.set(callerOf(m), m);
  const chosen = new Set<RunFinding>(byCaller.values());
  const deepest = members.reduce(
    (best, m) => (maxDepth(m) > maxDepth(best) ? m : best),
    members[0]!,
  );
  chosen.add(deepest);
  for (let i = 0; chosen.size < Math.min(n, members.length) && i < members.length; i++) {
    chosen.add(members[Math.floor((i * members.length) / n) % members.length]!);
  }
  return [...chosen];
}

export function groupClasses(findings: readonly RunFinding[], samplesPerClass = 5): FindingClass[] {
  const groups = new Map<string, RunFinding[]>();
  for (const f of findings) {
    const id = classId(f);
    const list = groups.get(id);
    if (list) list.push(f);
    else groups.set(id, [f]);
  }
  const classes: FindingClass[] = [];
  for (const [id, members] of groups) {
    const files = new Set(members.map((m) => m.handler.location.file));
    const callers = new Set(members.map(callerOf));
    classes.push({
      id,
      count: members.length,
      files: files.size,
      callers: callers.size,
      samples: pickSamples(members, samplesPerClass).map((m) => ({
        key: identityKey(m),
        fingerprint: fingerprint(m),
        at: at(m.location ?? m.handler.location),
        sourceAt: m.sources.map((src) => at(src.location)).filter((x) => x !== ''),
      })),
      fingerprints: members.map(fingerprint),
    });
  }
  return classes.sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
}

export interface SiteRollup {
  site: string;
  findings: number;
  callers: number;
}

export function rollupSites(findings: readonly RunFinding[]): SiteRollup[] {
  const sites = new Map<string, { findings: Set<string>; callers: Set<string> }>();
  for (const f of findings) {
    const fp = fingerprint(f);
    for (const src of new Set(f.sources.map(sourceClass))) {
      const site = `${f.status ?? '-'} ${src}`;
      const entry = sites.get(site) ?? { findings: new Set(), callers: new Set() };
      entry.findings.add(fp);
      entry.callers.add(callerOf(f));
      sites.set(site, entry);
    }
  }
  return [...sites]
    .map(([site, v]) => ({ site, findings: v.findings.size, callers: v.callers.size }))
    .sort((a, b) => b.findings - a.findings || a.site.localeCompare(b.site));
}

export interface RebaselineResult {
  file: VerdictFile | undefined;
  refusals: string[];
}

export function rebaseline(
  baseline: VerdictFile,
  findings: readonly RunFinding[],
  toolVersion: string,
  recordedAt: string,
  acceptLost: boolean,
): RebaselineResult {
  const delta = computeDelta(baseline.entries, findings);
  const refusals: string[] = [];
  if (delta.added.length > 0)
    refusals.push(`${delta.added.length} new finding(s) need triage first`);
  const lostTruePositives = delta.disappeared.filter((d) => d.verdict === 'TP');
  if (lostTruePositives.length > 0)
    refusals.push(`${lostTruePositives.length} true positive(s) disappeared`);
  const lostUnreviewed = delta.disappeared.filter((d) => d.verdict !== 'FP' && d.verdict !== 'TP');
  if (lostUnreviewed.length > 0 && !acceptLost) {
    refusals.push(
      `${lostUnreviewed.length} unreviewed finding(s) disappeared; pass --accept-lost after reviewing them`,
    );
  }
  if (refusals.length > 0) return { file: undefined, refusals };

  const carriedByAfter = new Map(delta.changed.map((c) => [c.after, baseline.entries[c.before]!]));
  const entries: Record<string, VerdictEntry> = {};
  for (const f of findings) {
    const fp = fingerprint(f);
    const previous = baseline.entries[fp] ?? carriedByAfter.get(fp);
    entries[fp] = previous
      ? { ...previous, key: identityKey(f) }
      : { verdict: 'UNTRIAGED', key: identityKey(f) };
  }
  return { file: { pin: baseline.pin, toolVersion, recordedAt, entries }, refusals };
}
