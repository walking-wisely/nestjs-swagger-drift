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
 *
 * Tier 2 (PLAN §10.3): for a fixable finding whose ONLY reason it's fixable
 * is the implicit success source (i.e. it's a success-status finding —
 * `200`/`201`/whatever `@HttpCode` says), also attempt
 * `resolveSuccessResponseType` against the handler's concrete return type.
 * When both of that function's gates pass, the resulting `FixEntry` carries
 * `responseType`, which `apply.ts` uses to emit `type: Dto`/`isArray: true`
 * on the inserted decorator instead of a bare stub. `checker` is optional
 * and passed through from `main()` (`program.getTypeChecker()`) — omitting
 * it (existing callers, and every non-success finding) just means Tier 2 is
 * never attempted, falling back to the Tier 1 stub, so this is additive and
 * doesn't change Tier 1's own behavior or tests.
 */

import * as ts from 'typescript';
import type { Finding, StatusSource } from '../../core/index.js';
import { resolveSuccessResponseType } from '../../core/index.js';
import { locationOf, type Location } from '../report/location.js';
import {
  escapeSingleQuoted,
  shorthandDecoratorForStatus,
  statusDescription,
} from './status-text.js';

/** Tier 2 (PLAN §10.3) type info attached to a success-status `FixEntry` once both of `resolveSuccessResponseType`'s gates pass. */
export interface FixEntryResponseType {
  /** The DTO class's own name, e.g. `'AccountingTemplate'`. */
  className: string;
  /** `true` when the handler resolves to an array of `className`. */
  isArray: boolean;
  /** Absolute source-file path where `className`'s class declaration lives — `apply.ts` needs this to compute (or skip) an import. */
  declarationFile: string;
}

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
  /** Tier 2 (PLAN §10.3), set only for a success-status entry whose type resolved and passed both gates. */
  responseType?: FixEntryResponseType;
  /**
   * Tier 2 (PLAN §10.3): set only for a success-status entry where type
   * resolution was ATTEMPTED but declined (either gate failed, or no
   * `checker` was supplied) — never set for a non-success entry, where
   * Tier 2 doesn't apply at all. `undefined` + `responseType` also
   * `undefined` therefore means "not applicable"; this field set means
   * "applicable, but here's why it fell back to the untyped stub" — the
   * "surface the case ... rather than just dropping it" signal PLAN §10.3
   * asks for, short of standing up the full `documented-status-untyped`
   * opt-in rule it names as a candidate follow-up.
   */
  typeSkippedReason?: string;
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
 * Attempts Tier 2 (PLAN §10.3) for a fixable success-status finding:
 * `resolveSuccessResponseType` against the handler's concrete node, and — if
 * it resolves — packages the result as the `responseType`/`typeSkippedReason`
 * pair `buildFixPlan` attaches to the entry. Returns `{}` (neither field set)
 * for a non-success finding or when no `checker` was supplied, matching
 * `FixEntry`'s "not applicable" convention.
 */
function resolveTier2(
  finding: Extract<Finding, { rule: 'undocumented-status' }>,
  checker: ts.TypeChecker | undefined,
): Pick<FixEntry, 'responseType' | 'typeSkippedReason'> {
  const isSuccess = finding.sources.some((s) => s.kind === 'implicit' && s.reason === 'success');
  const handlerNode = finding.handler.node;
  // `HandlerInfo.node` is typed as the broader `ts.Node` (PLAN §3.1's
  // `core/types.ts`), but `handlers.ts` only ever constructs one from an
  // actual `ts.MethodDeclaration` — narrowed here rather than widening
  // `resolveSuccessResponseType`'s own signature to accept a bare `ts.Node`
  // for a case that structurally can't happen.
  if (!isSuccess || checker === undefined || !ts.isMethodDeclaration(handlerNode)) return {};

  const resolution = resolveSuccessResponseType(handlerNode, checker);
  if (resolution.kind === 'skipped') return { typeSkippedReason: resolution.reason };

  return {
    responseType: {
      className: resolution.className,
      isArray: resolution.isArray,
      declarationFile: resolution.declaration.getSourceFile().fileName,
    },
  };
}

/**
 * Builds a `FixPlan` from a full findings list (as `main()` already has
 * it) — filters to `undocumented-status`, splits fixable from skipped, and
 * resolves each fixable one's insertion text. `baseDir` is only for
 * `FixEntry.location`'s report-friendly path; `FixEntry.file` always stays
 * the absolute `ts.SourceFile.fileName` ts-morph needs. `checker` is
 * optional and enables Tier 2 (PLAN §10.3) response-type resolution for
 * success-status entries — omit it to get Tier 1-only behavior.
 */
export function buildFixPlan(
  findings: readonly Finding[],
  baseDir: string,
  checker?: ts.TypeChecker,
): FixPlan {
  const entries: FixEntry[] = [];
  const skipped: FixSkipped[] = [];

  for (const finding of findings) {
    if (finding.rule !== 'undocumented-status') continue;

    if (!finding.sources.some(isDeterministicSource)) {
      skipped.push({
        finding,
        reason:
          'only sourced from opt-in implicit checks (validation-pipe/guards) — inference, not fact',
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
      ...resolveTier2(finding, checker),
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
