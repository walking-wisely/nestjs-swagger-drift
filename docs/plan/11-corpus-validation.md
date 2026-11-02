> Part of the [nestjs-swagger-drift implementation plan](../../PLAN.md).
> Section numbers are stable — 200+ code comments cite `PLAN §11`.

---

## 11. Real-world corpus validation (partially implemented — see §11.12)

### 11.0 Why

Every non-trivial bug found since Phase 7 started came from running against a
real repository, not from fixtures: CRLF sniffing, JSDoc-triggered indentation
misdetection, the `moduleResolution: node` import-specifier bug (§10.5.3),
the namespace-import crash, the `pos`-invalidation bug that silently dropped 3
valid findings. Fixtures confirm a fix works on the case that exposed it; they
cannot show that a sibling bug of the same shape isn't sitting in the next
file over. Only file diversity does that.

But real-world runs are unusable as a routine check in their raw form. Ever
Gauzy `packages/core` produces **554 findings across 136 files**. The one full
triage of that output (2026-08-07) took 14 parallel review agents, and two
batches came back with verdict arithmetic that didn't reconcile. Re-triaging
554 findings on every change is not a policy anyone will follow twice.

This section specifies the mechanism that makes real-world validation cheap
enough to be routine: **triage results are persisted per finding, so each run
only costs the delta.**

### 11.1 Design principle — diff triaged baselines, never raw output

A validation run classifies the current findings against a stored, verdicted
baseline into four buckets. Two of them are free:

| Bucket          | Definition                                     | Cost                           |
| --------------- | ---------------------------------------------- | ------------------------------ |
| **unchanged**   | fingerprint in both baseline and run           | free — verdict carries forward |
| **new**         | fingerprint only in run                        | needs triage                   |
| **disappeared** | fingerprint only in baseline                   | needs triage                   |
| **changed**     | same handler+rule+status, different source set | needs triage (delta only)      |

The **disappeared** bucket is the reason this is a baseline mechanism rather
than "read the new output and see if anything looks wrong." A reviewer reading
output catches new false positives; nothing about reading output catches a
detection the tool used to make and silently stopped making. For a tool whose
entire promise is _fails CI when drift exists_, a lost true positive is the
more dangerous regression, and it is invisible without a stored prior.

### 11.2 Corpus

Frozen SHAs, deliberately. Re-pinning to newer upstream commits invalidates
every verdict it touches and buys very little — a 2026 NestJS codebase is not
meaningfully less realistic than a 2027 one. Refreshing a pin is an explicit,
separately-reviewed operation (§11.9), not routine maintenance.

| Repo                      | Scope                                 | Role                                                                                                                                                                       |
| ------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ever-co/ever-gauzy`      | `packages/core` (`tsconfig.lib.json`) | Volume and mess: 159 controllers, deep DTO inheritance, custom decorators, multi-tenant guards. The 554-finding stress case. `moduleResolution: node`.                     |
| `novuhq/novu`             | `apps/api`                            | The inverse test: a well-documented modern codebase where findings _should_ be near-zero. A **rise** here is a false-positive alarm in a way a rise in Gauzy's 554 is not. |
| `immich-app/immich`       | `server/`                             | Ships a generated OpenAPI spec in-repo — findings can be cross-checked against what the project actually publishes, rather than against a reviewer's reading.              |
| `amplication/amplication` | `apps/server`                         | Guard/decorator edge cases: JWT + API-key auth, GraphQL/REST hybrid controllers.                                                                                           |

Only Ever Gauzy has ever been run. The other three were selected during the
2026-08 corpus discussion and have no baseline yet.

### 11.3 Storage

Clones are **not** committed. They live in a pinned, prepared cache:

```
~/.cache/nestjs-swagger-drift-corpus/<repo-id>/    # checkout at manifest SHA, deps installed
```

Preparation is the expensive step and is done once per pin — Ever Gauzy's
`yarn install` pulls ~10GB (Electron/desktop deps included, though only
`packages/core` is analysed) and takes several minutes. Runs that mutate the
checkout (`--fix`) operate on a throwaway copy or `git reset --hard` back to
the pinned SHA afterwards; the 2026-08-08 session lost time to a checkout left
dirty with 136 previously-fixed files.

Committed to this repo:

```
corpus/
  manifest.json              # repo id, remote, SHA, tsconfig, scope, CLI flags, prep command
  <repo-id>/
    verdicts.json            # fingerprint -> verdict map (see 11.5)
    autofix.patch            # the git diff `--fix` produces at this pin
    notes.md                 # known-FP patterns and why they are FPs, prose
```

`verdicts.json` deliberately stores **only** `fingerprint -> verdict`, not the
finding payloads. A full 554-entry payload baseline would dominate this repo's
diffs for a file no human reads directly. The trade-off, stated so it isn't
rediscovered later: a verdicts file cannot be _interpreted_ without a run to
join it against — an orphaned fingerprint is an opaque hash. That is
acceptable because the file is only ever consumed by the delta step, which by
definition has a fresh run in hand. `notes.md` carries the human-readable
record of _why_ recurring FP classes are FPs.

### 11.4 Fingerprint

Line numbers cannot be part of identity: the target repo would churn even if
it were not frozen, and autofix itself shifts every line below each insertion.

```
sha1(relativeFilePath + '\0' + className + '\0' + methodName + '\0'
     + rule + '\0' + status
     + '\0' + sorted(sources.map(s => s.kind + ':' + (s.exception ?? s.reason) + ':' + (s.via ?? []).join('>'))).join('|'))
```

Every input is already present in `--reporter json` (`src/cli/report/json.ts`)
— the detect side needs no tool change.

Including the source set in the hash is what makes "same status, now derived
from a different reason" surface as **changed** rather than hiding inside
**unchanged**. A finding that flips from `service-throw via A>B` to
`implicit` is a behaviour change worth a look even though the reported status
is identical. The cost is that a source-set change presents as a
disappeared+new pair; the delta step pairs them back up by
`(file, class, method, rule, status)` and reports them as **changed**, showing
only the source diff.

### 11.5 Verdict file

```jsonc
{
  "pin": "e7ac0ac…", // must match manifest; mismatch = verdicts are stale, hard error
  "toolVersion": "0.1.2",
  "triagedAt": "2026-08-10",
  "verdicts": {
    "3f9a…": "TP",
    "b21c…": "FP", // an FP recorded here is a known, accepted defect — see notes.md
    "77de…": "UNCLEAR",
  },
}
```

`FP` entries are load-bearing: they are the tool's known false positives at
this pin, and the gate in §11.6 fires on _new_ FPs, not on the presence of
FPs. Clearing an FP (a fix landing) shows up as a disappeared-FP, which is an
improvement and needs no approval.

### 11.6 Gates

Automated, no judgement required:

1. `tsc --noEmit` clean on the target **before** fix (proves the pin is a sane
   baseline) and **after** fix
2. re-detect after `--fix` → 0 in-scope findings
3. second `--fix` → no-op (idempotency)
4. `notApplied` / `skippedFiles` counts match the baseline; exit code as expected
5. `autofix.patch` byte-identical to the committed one, or the diff-of-diffs
   presented for review

Requiring triage to have completed:

6. zero **new** findings verdicted `FP`
7. zero **disappeared** findings whose baseline verdict was `TP`

Gates 6 and 7 are the blockers. Everything else is either mechanical or an
improvement.

### 11.7 Tiers

Full corpus runs are too expensive to be the only mode.

| Tier         | Repos        | Runs                                        | Trigger                                          |
| ------------ | ------------ | ------------------------------------------- | ------------------------------------------------ |
| **smoke**    | Gauzy        | detect + delta, no fix                      | any `src/core/**` change                         |
| **standard** | Gauzy + Novu | detect + full autofix cycle + all gates     | any `src/cli/fix/**` change; before merging a PR |
| **full**     | all four     | everything, plus Immich OpenAPI cross-check | before a version bump                            |

With a prepared cache, smoke is ~10s of analysis (the 2026-08-07 run analysed
159 controllers in 9.4s).

### 11.8 Split of responsibilities

**`scripts/corpus.ts`** (repo-local, not in the published `dist/`) does
everything deterministic: resolve the pin, prepare/verify the cache, run
detect with the manifest's flags, fingerprint, load verdicts, compute the
four-bucket delta, run the fix cycle in a throwaway checkout, execute gates
1–5, and write `delta.json`.

Fingerprinting and set-diffing 554 findings by hand in an agent's context is
exactly the mechanical work that produced the unreconciled batch arithmetic in
the first triage. It belongs in code.

**The skill** (`corpus-check`) does only what requires judgement:

1. Run the script at the requested tier; report gate 1–5 results verbatim.
2. If the delta is empty and gates pass → done, one-paragraph report, no
   approval needed.
3. Otherwise triage **new**, **disappeared**, and **changed** entries only —
   opening the actual source at each cited location, as the 2026-08-07 batch
   review did. Batching across sub-agents is fine; each verdict must cite the
   file:line it was derived from.
4. **Present to the user for approval, and only these:** proposed `FP`
   verdicts on new findings, and disappeared findings whose stored verdict was
   `TP`. These are the two blocker classes. Everything else — new `TP`s
   (the tool got better), disappeared `FP`s (a fix landed), `changed` entries
   with an equivalent source set — is auto-accepted and merely summarized.
5. On approval, write the updated `verdicts.json` (+ `autofix.patch`,
   - `notes.md` entries for any new accepted FP class) and emit a report
     suitable for pasting into the PR.

The skill must **not** silently widen an FP: recording a new finding as `FP`
is recording a known defect, and that is the user's call, not the agent's.
`UNCLEAR` is a legitimate terminal state and does not block.

### 11.9 Non-goals and deliberate omissions

- **Not in per-PR CI.** A 10GB `yarn install` per PR is not a reasonable
  GitHub Actions job. Pre-merge validation stays a manual, local ritual whose
  report gets pasted into the PR. The unattended check is the nightly job in
  §11.12, which runs the smoke tier only.
- **No pin refreshing on a schedule** (§11.2).
- **No bootstrapping of baselines as part of this plan.** Standing up
  `verdicts.json` for Gauzy — and standing up the other three repos at all —
  is separate work, done once the mechanism exists.

### 11.10 Supporting tool change (optional)

The detect path is fully machine-readable; the fix path is not. `--fix`
reports `wrote N insertion(s) across M file(s)`, per-file `fixed …` lines, and
`not applied: … — reason` lines, all as stderr prose
(`src/cli/index.ts:707-737`). Gate 4 would therefore have to regex a format
nobody promised to keep stable.

Parsing it works and is where this should start. If corpus runs become
routine, add `--fix-report <path>` emitting
`{insertions, filesChanged, notApplied[], typeSkipped[], skippedFiles[]}` as
JSON — a stable contract for the gate, and independently useful to any CI
consumer of `--fix`.

### 11.11 Build order

1. `corpus/manifest.json` with all four repos pinned; only Gauzy prepared.
2. `scripts/corpus.ts`: prepare + detect + fingerprint + delta, `smoke` tier
   only. Verify the fingerprint is stable across two identical runs and
   survives an unrelated whitespace edit to a target file.
3. Bootstrap Gauzy's `verdicts.json` (separate task, per §11.9).
4. Fix cycle + gates 1–5, `standard` tier; commit `autofix.patch`.
5. The `corpus-check` skill on top.
6. Novu, then Immich and Amplication baselines — each its own triage session.

### 11.12 Implemented so far

- `corpus/manifest.json` pins Ever Gauzy and Novu at the SHAs current on
  2026-11-02. The SHA behind the original 554-finding triage was not recorded,
  so the Gauzy pin is a fresh one and its finding count will differ.
  Immich and Amplication are not pinned yet (§11.11 step 6).
- `scripts/corpus/cli.ts` (`npm run corpus -- <prepare|bootstrap|run> <repo-id>`)
  and `scripts/corpus/lib.ts` (fingerprint and delta, unit-tested in
  `test/unit/corpus-lib.test.ts`). Needs `npm run build` first and Node with
  native type stripping (22.18+).
- `verdicts.json` stores `{ verdict, key }` per fingerprint, not a bare verdict
  (this amends §11.3 and §11.5). The key is `file::Class.method rule status`.
  Without it a **disappeared** finding is an opaque hash, and the delta cannot
  pair a source-set change into **changed**. Added a fourth verdict value,
  `UNTRIAGED`, for baselines recorded by `bootstrap` before anyone has
  reviewed them.
- `run` exits `1` on any new finding, any changed finding, or any disappeared
  finding whose verdict is not `FP`. That is stricter than gates 6 and 7: with
  no human present, every unreviewed delta is treated as blocking.
- `.github/workflows/corpus-nightly.yml` runs `prepare` + `run` for Gauzy
  daily at 03:17 UTC and on `workflow_dispatch`, uploading `delta.json`. It
  reinstalls dependencies every run: the cache limit (10GB per repository)
  is smaller than the install.
- `corpus report <id>` groups findings into classes (`rule | status | source
kind@call-depth:exception`) and prints counts, file spread, and sample
  locations; the full list with per-class fingerprints goes to
  `<out>/<id>.classes.json` as input for class-level triage.
- Not done: the fix cycle and gates 1–5, `autofix.patch`, the `corpus-check`
  skill, Novu/Immich/Amplication baselines.
