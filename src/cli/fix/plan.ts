/**
 * Tier 1 autofix (PLAN §10.2): builds a plan of `@Api*Response`
 * insertions from `undocumented-status` findings whose sources resolve
 * deterministically, without touching the filesystem or ts-morph — kept
 * separate from `apply.ts` so the "which findings are fixable and with
 * what decorator" decision is unit-testable against plain `Finding`
 * objects, independent of file I/O.
 *
 * Scope (PLAN §10.2, "Explicitly excluded"): a finding is fixable only if
 * at least one of its `sources` is a fact this tool is certain of — a
 * direct `throw`, a `service-throw` resolved within `--max-depth`, or the
 * implicit success status. A finding sourced ONLY from the opt-in implicit
 * rules (`checkValidationPipe`'s `400`, `checkGuards`'s `401`/`403`) is
 * skipped: those are inferences about intent ("a guard is attached, so it
 * PROBABLY throws"), not facts, and PLAN §10.1's whole premise is that a
 * wrong autofix is worse than a wrong warning. `unresolvable-status` and
 * `documented-but-unreachable` findings are out of scope entirely — neither
 * is an `undocumented-status` finding, so nothing to insert a decorator for.
 */

import type { Finding, StatusSource } from '../../core/index.js';
import { locationOf, type Location } from '../report/location.js';
import { escapeSingleQuoted, shorthandDecoratorForStatus, statusDescription } from './status-text.js';

/** One `@Api*Response` decorator this plan will insert. */
export interface FixEntry {
  /** Absolute path, exactly as `ts.SourceFile.fileName` reports it — what `ts-morph` needs to reopen the file. */
  file: string;
  status: number;
  /** e.g. `'ApiNotFoundResponse'`, or `'ApiResponse'` when no shorthand exists for `status`. */
  decoratorName: string;
  isShorthand: boolean;
  /** Pre-escaped for direct interpolation into a single-quoted string literal. */
  description: string;
  handlerClassName: string;
  handlerMethodName: string;
  /** `finding.node.getStart()` in the ORIGINAL (unmodified) file — how `apply.ts` relocates this handler in a freshly-parsed ts-morph tree. */
  methodStartPos: number;
  /** For reporting only. */
  location: Location;
}

/** An `undocumented-status` finding this plan declined to fix, and why. */
export interface FixSkipped {
  finding: Extract<Finding, { rule: 'undocumented-status' }>;
  reason: string;
}

export interface FixPlan {
  entries: FixEntry[];
  skipped: FixSkipped[];
}

function isDeterministicSource(source: StatusSource): boolean {
  if (source.kind === 'throw' || source.kind === 'service-throw') return true;
  return source.kind === 'implicit' && source.reason === 'success';
}

/**
 * Builds a `FixPlan` from a full findings list (as `main()` already has
 * it) — filters to `undocumented-status`, splits fixable from skipped, and
 * resolves each fixable one's insertion text. `baseDir` is only for
 * `FixEntry.location`'s report-friendly path; `FixEntry.file` always stays
 * the absolute `ts.SourceFile.fileName` ts-morph needs.
 */
export function buildFixPlan(findings: readonly Finding[], baseDir: string): FixPlan {
  const entries: FixEntry[] = [];
  const skipped: FixSkipped[] = [];

  for (const finding of findings) {
    if (finding.rule !== 'undocumented-status') continue;

    if (!finding.sources.some(isDeterministicSource)) {
      skipped.push({
        finding,
        reason: 'only sourced from opt-in implicit checks (validation-pipe/guards) — inference, not fact',
      });
      continue;
    }

    const shorthand = shorthandDecoratorForStatus(finding.status);
    entries.push({
      file: finding.node.getSourceFile().fileName,
      status: finding.status,
      decoratorName: shorthand ?? 'ApiResponse',
      isShorthand: shorthand !== undefined,
      description: escapeSingleQuoted(statusDescription(finding.status)),
      handlerClassName: finding.handler.className,
      handlerMethodName: finding.handler.methodName,
      methodStartPos: finding.node.getStart(),
      location: locationOf(finding.node, baseDir),
    });
  }

  return { entries, skipped };
}

/** Groups `entries` by `file`, preserving first-seen file order — what `apply.ts` iterates over. */
export function groupEntriesByFile(entries: readonly FixEntry[]): Map<string, FixEntry[]> {
  const byFile = new Map<string, FixEntry[]>();
  for (const entry of entries) {
    const existing = byFile.get(entry.file);
    if (existing) existing.push(entry);
    else byFile.set(entry.file, [entry]);
  }
  return byFile;
}
