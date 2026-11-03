---
name: corpus-triage
description: How to triage findings from the pinned real-world corpus (Ever Gauzy, Novu, Immich, Amplication) into TP / FP / UNCLEAR verdicts, record them in corpus/<id>/verdicts.json, and turn false-positive classes into analyser fixes. Use when triaging a corpus baseline, reviewing a corpus delta, or deciding whether a finding on a real repo is wrong.
---

# Corpus triage

Goal: decide, for every finding the tool reports on a pinned real repository, whether it is
true, and feed every wrong one back into the analyser. Triage exists to find false positives
(FPs) to fix, not to produce a green baseline.

## Files and commands

- `corpus/manifest.json` pins each repo (SHA, tsconfig, prepare steps). Checkouts live in
  `~/.cache/nestjs-swagger-drift-corpus/<id>`.
- `corpus/<id>/verdicts.json`: `entries[fingerprint] = { verdict, key, basis? }`, verdict one of
  `TP | FP | UNCLEAR | UNTRIAGED`. `key` is `file::Class.method rule status`.
- `corpus/<id>/swagger-drift.config.json` (optional) is passed to every run.
- `corpus/<id>/notes.md` records FP classes, fixes and reviewer caveats. Append to it.
- `npm run build` first; the scripts run `dist/`.
- `npm run corpus -- prepare|report|run|rebaseline <id>` (`bootstrap` once per repo).
  `report` groups findings by leaf throw site; `run` prints the delta against the baseline;
  `rebaseline` refuses on new findings or lost TPs (`--accept-lost` for unreviewed
  disappearances).
- To see each finding's sources: run `node dist/cli/index.js --project <checkout>/<tsconfig>
--base-dir <checkout> --reporter json --config corpus/<id>/swagger-drift.config.json`
  (add `--explain` for call hops and enclosing conditions). Findings carry `confidence: low`
  and `confidenceReasons` when every source is weak.

## Order of work

1. Split the baseline mechanically before reading any code:
   - Implicit-success findings (`implicit:success` source). Check per group: has `@HttpCode`;
     documents a different 2xx; has no `@ApiResponse` at all. Verify a few by hand per group,
     then decide the group. These are usually TP.
   - High-confidence thrown-status findings.
   - Low-confidence findings (throw in a catch block, or a guard that only checks a bare
     parameter). Triage these separately: most FPs live here, but many are TP.
2. Group thrown-status findings by leaf throw site, not call depth. One site often explains
   dozens of findings.
3. Inventory the repo once: global guards, filters, interceptors, pipes (`ValidationPipe`
   registration, `APP_GUARD`, `useGlobal*`). Hand it to every reviewer.
4. Review in batches of about 20-40 findings per reviewer, one concern per batch (a throw
   site, or one low-confidence shape). Mix 2-3 known-answer items into each batch (one known
   TP, one known FP from an earlier baseline) and distrust the batch if they come back wrong.
5. Spot-check the biggest FP claims yourself before recording them. A claimed FP class with
   many members deserves a second, adversarial reviewer.
6. Record verdicts, then fix analyser FP classes (below), rebaseline, and append to `notes.md`.

## Reviewer rules

Give reviewers these rules verbatim. Do not tell them the tool's claimed status; ask them to
work out what the handler can return and compare.

- Judge blind: read the handler and its callees, decide which HTTP statuses it can produce,
  only then compare with the finding.
- Cite `file:line` and quote the guard expression and the argument actually passed at the
  call site. Prose, JSDoc and names are not evidence.
- Name every hop from handler to throw, or state "no catch in frames X..Y".
- Try to disprove the finding: look for a wrapping `try`/`catch`, a pipe, a validator DTO, a
  guard that already rejects, a caller that always passes a constant.
- A finding is TP if any one source is reachable. FP only if every source is unreachable.
- UNCLEAR when the only way to reach it is a race, a database outage, or an environment the
  repo does not run in by default. Never use UNCLEAR for "I did not look".
- Return one JSON object per finding: fingerprint, verdict, basis, and the cited lines.

Briefs you write are claims too. Do not assert a line is unreachable in the brief; a wrong
hint in a brief produced eight wrong verdicts once and had to be overridden.

## Policy decisions already made

- If a wrapper's null-check is dead but the callee still throws the same status, the finding
  stays TP. The tool attributes the wrong throw site; note that, do not call it FP.
- `catch` that remaps any error to an HttpException is TP when the try body can fail for a
  reason a client controls (unvalidated `where`, `relations`, ids reaching the DB), UNCLEAR
  when only infrastructure can fail, FP when the catch cannot run (see below).
- Demo-only, ORM-specific or optional-integration paths are recorded TP with the caveat in
  `basis`; they are real for some deployments.
- A guard that is excluded from docs (`@ApiExcludeController`, `@ApiExcludeEndpoint`) is not
  a finding at all; the analyser skips those handlers.

## Recording verdicts

- `basis` is a stable tag, not a line number you will have to re-find:
  `site:<file>:<line>#<reason>` for a throw-site verdict that applies to many findings, or
  `ai-triage:<Class.method>#<reason> <cited file:line and one sentence>`.
- Write verdicts with a throwaway script over `verdicts.json` keyed by fingerprint; verify
  that no entry is left `UNTRIAGED` and that the TP/FP/UNCLEAR counts match what reviewers
  returned. Keep that script outside the repo.
- Never edit a fingerprint by hand. If source sets changed, `rebaseline` carries verdicts.

## Turning FPs into fixes

Classify each FP before touching code:

| FP shape                                                                                                                         | Action                                                                                                                               |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Guard on a parameter the caller sets to a constant or a typed value                                                              | Argument-aware traversal (`src/core/const-eval.ts`); fix if the fact is decidable from literals, bound parameters or call-site types |
| Precondition enforced by a named guard class                                                                                     | `guardGuarantees` in `corpus/<id>/swagger-drift.config.json`                                                                         |
| Handler excluded from docs                                                                                                       | Already skipped; check the decorator provenance                                                                                      |
| Catch that cannot run (try body only returns un-awaited async calls; `finally { return }`)                                       | Already handled in `thrown.ts`; extend only with a checker-proven rule                                                               |
| DTO-validator exclusion, defense-in-depth re-check, internal-only parameter, correlated guards across frames, pipe preconditions | Not fixable by a syntactic tool. Record in `notes.md`, keep the verdict FP, do not add heuristics                                    |

The tool is deliberately syntactic: do not add a heuristic that infers intent to clear a
class of FPs. A fix needs a test (unit or fixture) and, after rebuilding, a corpus `run` that
shows the FPs gone, no TP or UNCLEAR lost, nothing new. Then `rebaseline`.

## Done criteria for a repo

- No `UNTRIAGED` entries.
- `notes.md` lists every FP class with the file:line evidence, fixed or not fixed.
- `npm run corpus -- run <id>` reports zero new, changed or disappeared findings.
- Counts of TP / FP / UNCLEAR are in the commit message or PR description.

Commits author as the `walking-wisely` noreply address (see the `git-issues` skill).
