> Part of the [nestjs-swagger-drift implementation plan](../../PLAN.md).
> Section numbers are stable — code comments may cite `PLAN §12`.

---

## 12. Next steps

State as of 2026-11-02: v0.1.2 published; Tiers 1–2 autofix implemented; corpus
tooling, nightly job and `--explain` in place (§11.12); Ever Gauzy baselined with
700 findings, all `UNTRIAGED`.

### 12.1 Verify the nightly job (done 2026-11-02)

Dispatched run 41509605224 succeeded in about 17 minutes with 686 findings, all unchanged; the install fits the runner and the disk-cleanup step is enough. Fixing a `runner` context error in the job `env` was needed first.

1. Trigger `Corpus nightly` via `workflow_dispatch` and watch it. Unverified:
   whether the ~16-minute Gauzy install fits the runner's disk and the 90-minute
   timeout (the disk-cleanup step is a guess).
2. If the install does not fit, options in order of preference: install only the
   workspaces `packages/core` depends on; a self-hosted runner; drop the nightly
   and keep corpus runs local.
3. Decide who is notified on failure (default: the workflow's failure email).

### 12.2 Triage the Gauzy baseline (§11.1, §11.5)

Method validated by the 2026-11-02 pilot on `currentUser#throwError`:

1. Group by leaf throw site, not call depth: `npm run corpus -- report ever-gauzy`
   prints the per-site rollup and writes `<out>/ever-gauzy.sites.json`.
2. Split the implicit-success classes (357 findings) mechanically: has
   `@HttpCode`; documents a different 2xx; has no `@ApiResponse` at all. Verify a
   couple by hand per group, then decide usefulness once per group.
3. One reviewer per throw site for the top ~30 sites (the CRUD base services in
   `crud.service.ts` and `tenant-aware-crud.service.ts` carry roughly 200
   findings between them). Batch the long tail.
4. Reviewer rules: judge blind (hide the tool's claimed status); cite the guard
   expression and the argument passed at the call site, never prose or JSDoc;
   name every hop or state "no catch in frames X..Y"; start from a one-time
   inventory of global guards, filters, interceptors and pipes; mix in known-answer
   items to detect an unreliable batch.
5. Adversarial pass only on large true-positive sites.
6. Store verdicts with `basis: "site:<file>:<symbol>#<condition>"`, not a class id
   (class ids contain structure that changes). Extrapolated verdicts with low
   confidence are `UNCLEAR`, which does not block.
7. Findings with several throw sites need per-source attribution; the verdict
   schema cannot express "status right, some cited paths dead" yet.

### 12.3 Recall (false negatives)

A findings-only baseline cannot see misses, and 118 of 190 Gauzy controllers
extend `CrudController`, whose inherited routes are not discovered (§6).

1. Enumerate routes independently (grep the route decorators, expand inherited
   `CrudController` routes) and diff against the handlers the tool analysed.
2. Add a debug listing of each handler's resolved statuses, documented ones
   included, so a reviewer can tell "documented" from "missed".
3. Sample on purpose by known miss shapes from §6: `throw new HttpException(msg,
variable)`, throws inside callbacks, `throw new X(this.helper())`.
4. Consider implementing inherited-handler discovery; it is the largest known
   under-reporting gap.

### 12.4 Corpus tooling to finish (§11.11)

- Fix cycle and gates 1–5 for the `standard` tier; commit `autofix.patch`.
- `corpus-check` skill on top of the script.
- Novu baseline recorded (338 findings, all `UNTRIAGED`); Immich and Amplication are not pinned yet.
- `--fix-report <path>` (§11.10) if gate 4 parsing proves brittle.
- ~~Fingerprint stability under an unrelated edit~~ — tested in `corpus-lib.test.ts`.
- Migration step for verdicts when a pin is refreshed (carry by `Class.method`).

### 12.5 Analyser gaps found by the corpus

- Extend argument-aware traversal only where evidence appears: today it decides
  conditions built from literals and bound parameters; a flag computed at the call
  site stays "possibly true" (§6).
- The remaining Gauzy 401 sites (`hasPermissions` family with non-constant flags)
  need their own review before deciding whether anything more is wrong.
- ~~Regression test that spawns the built binary with a report over 64KB~~ — done
  (`test/integration/large-report.test.ts`).

### 12.6 Open decisions still unmade (§9)

Distribution route (standalone vs `nestjs-doctor` rule vs contributing to
`eslint-plugin-nestjs-typed`), `documented-but-unreachable` value, success-check
default, `@ApiException` support. Revisit once the Gauzy triage gives real
false-positive numbers.
