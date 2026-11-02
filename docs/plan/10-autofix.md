> Part of the [nestjs-swagger-drift implementation plan](../../PLAN.md).
> Section numbers are stable — 200+ code comments cite `PLAN §10`.

---

## 10. Phase 7 — Autofix (detailed design)

### 10.0 Motivation

Validated 2026-08-07 against `ever-co/ever-gauzy` (`packages/core`, 159
controllers): **554 findings, 0 false positives** across 14 independent
review passes reading the actual source at each cited location. That number
is the argument for this feature — nobody hand-writes 554 decorators, so
today the tool accurately tells you how bad the drift is and then asks you to
close the gap by hand. Autofix is what converts "accurate report" into
"actually closes the gap on a messy codebase." See conversation log /
session notes for the full run (clone → `yarn install` → CLI in 9.4s → batch
review); not reproduced here.

### 10.1 Design principle

Ship by confidence tier, not as one feature. A wrong autofix is worse than a
wrong warning (per §5 Phase 7), so each tier only ships once the tier below it
is trustworthy in practice, and every tier has a dry-run mode before a
write-in-place mode.

### 10.2 Tier 1 — status-only stub fix

**What:** for `undocumented-status` findings whose `sources` resolve
deterministically — direct `throw`, `service-throw` resolved within
`--max-depth`, or implicit success — insert the matching `@ApiResponse`-family
decorator (shorthand where one exists: `@ApiNotFoundResponse`,
`@ApiConflictResponse`, etc.; generic `@ApiResponse({ status })` otherwise).
Explicitly **excluded**: `unresolvable-status` findings and anything sourced
only from the opt-in implicit rules (`--check-validation-pipe`,
`--check-guards`) — those are inferences about intent, not facts the engine is
certain of. Findings marked low confidence (`findingConfidence`) are skipped
too: a throw inside a `catch` block or behind a bare parameter-emptiness check
is a weak signal, and a wrong decorator is worse than a missing one.

**Description text:** derived from the same exception-class → status table
the engine already uses for detection (§4.2) — "Not Found", "Conflict", etc.
— or the `HttpStatus` name for implicit success. No attempt at richer prose.

**Mechanics:**

- ts-morph node mutation (`addDecorator` on the method), not text-offset
  patching — avoids position drift when a single file gets multiple
  insertions (common: Ever Gauzy controllers averaged ~3.5 findings/file).
- One `@nestjs/swagger` import managed/deduped per file, all edits for a file
  applied before that file is saved once.
- `--fix-dry-run` ships first: unified diff per file, no writes. `--fix`
  (write in place) ships only after dry-run has had a real usage cycle —
  autofix tools earn trust slowly and lose it in one bad run.

**Exit criteria:** run `--fix` against a large real repo (Ever Gauzy is the
known-good fixture); re-running the detector afterward hits 0 findings for
this tier's rule scope; `tsc --noEmit` still passes; running `--fix` a second
time is a no-op (idempotency).

**Estimate:** ~3–4 days (insertion mechanics, dry-run, write mode, idempotency
tests).

### 10.3 Tier 2 — type-aware fix (implemented — see §10.5.4)

**What's added over Tier 1:** for _success_-status findings, attach
`type: SomeDto` (and `isArray: true` where applicable) to the inserted
decorator instead of leaving the response body untyped. Error-status findings
don't generally carry a documented payload, so this is scoped to success
codes only.

**Mechanism:** resolve the handler's _concrete_ return type via the
TypeChecker at the overriding/concrete call site — not the generic
declaration. This is cheap given the existing ts-morph/checker setup already
used for exception resolution: ask for the resolved signature's return type,
unwrap `Promise<T>`, resolve `T` to a class declaration if one exists. If `T`
is `SomeClass[]` or `Array<SomeClass>`, unwrap the array, apply the gate to
the element type, and set `isArray: true` on the emitted decorator.

**Gate — only emit `type:` when:**

1. The resolved type is a **class**, not an interface or type alias. Swagger's
   `@ApiProperty()` reflection needs a runtime constructor; interfaces don't
   exist at runtime.
2. That class already carries **at least one `@ApiProperty()` or
   `@ApiPropertyOptional()`**. Otherwise the emitted schema is syntactically
   valid but empty or misleading — worse than the untyped Tier 1 stub, not
   better.

If the gate fails, fall back silently to the Tier 1 stub and surface the case
in a follow-up signal (candidate new opt-in rule,
`documented-status-untyped`) rather than just dropping it — the point is to
tell the user "you'll need to type this one by hand," not to hide the gap.

**Import handling:** adding the resolved DTO class as a new import into the
controller file needs collision detection (name already imported for a
different symbol) and a relative-vs-package-path decision depending on where
the DTO lives relative to the controller.

**Validation fixtures (from the Ever Gauzy run — use both, they're the
positive and negative case):**

1. **Positive case.** `CrudController<T extends BaseEntity>` declares
   `async findById(...): Promise<T>`
   (`packages/core/src/lib/core/crud/crud.controller.ts:100`).
   `AccountingTemplateController extends CrudController<AccountingTemplate>`
   (`accounting-template.controller.ts:38`). Resolving the checker at the
   concrete class should yield `Promise<AccountingTemplate>` directly — TS
   does the generic substitution for us. This is the case that proves the
   mechanism works.
2. **Negative case — required, not optional.** The same base class declares
   `async pagination(...): Promise<IPagination<T> | undefined>`
   (`crud.controller.ts:60`), where `IPagination` is an **interface** imported
   from `@gauzy/contracts`, not a class. There is no runtime constructor to
   reflect. The gate above must catch this and fall back to Tier 1 — emitting
   `type: IPagination` would be a real bug, not just an incomplete feature.
   Ship this as a regression fixture alongside the positive case so the gate
   can't silently regress.

**Estimate:** _(Original plan, superseded — see §10.5.4 for what actually shipped:)_
~1 week research spike (validate resolution + gate against Ever Gauzy plus 1–2
structurally different real repos — different generic/DTO conventions matter
here, one repo's pattern will not generalize) _before_ committing to
implementation; ~1 week to implement if the spike says go. (Collapsed into single
pass, implemented 2026-08-08.)

### 10.4 Tier 3 — long tail (deferred, not scoped yet)

Do not estimate these until the Tier 2 spike reports back — it will tell us
whether "Tier 1 stub + human fills in the type" is already the sweet spot, or
whether it's worth chasing further:

- Union/nullable returns (`Promise<T | null>`) — arguably a _detection_
  problem (an implied undocumented 404) as much as an autofix one.
- Generic envelope conventions (pagination wrappers like `IPagination<T>`
  above). Correct Swagger representation needs `@ApiExtraModels` +
  `getSchemaPath` boilerplate, and every codebase invents its own envelope
  shape — likely config-driven per-repo rather than inferable.
- Cross-file import ergonomics at scale: barrel files, path aliases,
  circular-import risk when pulling a DTO into a controller file.

### 10.5 Sequencing / exit criteria

1. [x] Tier 1 dry-run ships behind a flag (`--fix-dry-run`); validated on the
       Ever Gauzy fixture 2026-08-07 (554 → 0 on re-run for in-scope findings,
       second `--fix` run is a no-op, `tsc --noEmit` clean on the fixed tree).
       Implementation: `src/cli/fix/{plan,apply,format-diff}.ts`, wired into
       `cli/index.ts` as `--fix-dry-run`/`--fix`. Two real bugs found and fixed
       during the Ever Gauzy validation run, both regression-tested in
       `test/fixtures/fix-tier1/src/tab-indented.controller.ts`:
   - Inserting via ts-morph's `addDecorator` (append) put the new decorator
     text between the last existing decorator and the method, which is
     exactly where that decorator's own trailing line comment lives —
     reassociated the comment onto the new decorator. Fixed by
     `insertDecorator(0, ...)` (prepend) instead.
   - `IndentationText` was hardcoded to two spaces; a tab-indented file (Ever
     Gauzy's own `app.controller.ts`) got a spaces-next-to-tabs inserted
     line. Fixed by sniffing each file's own dominant indentation before
     constructing its `ts-morph` `Project`.
2. [x] Tier 1 write mode ships (`--fix`) alongside dry-run rather than as a
       separate follow-up — both landed and were validated together in the same
       pass; see item 1.
       2.1. [x] `tsc --noEmit` never calls a decorator factory, so it can't tell you
       whether the code Tier 1 generates actually RUNS. Closed with a permanent
       test, `test/integration/fix-decorator-runtime.test.ts`, that executes
       generated decorator calls against the REAL `@nestjs/swagger` package
       (`test/helpers/real-swagger-decorators.ts`: a narrowly-scoped
       `Module._resolveFilename` redirect makes the aliased `nest-swagger-
snapshot`/`nest-common-snapshot` packages actually loadable without ever
       creating `node_modules/@nestjs/common` under its real name — see that
       file's doc comment). Found and fixed a real bug on the first run:
       `SHORTHAND_RESPONSE_DECORATORS` (`core/nest-exceptions.ts`) is a superset
       of what `@nestjs/swagger` actually exports — its shorthand decorator
       EXPORT LIST is hand-maintained separately from the internal, fully
       mechanical `HttpStatus`-driven generation its own doc comment claimed
       "can't drift." 7 statuses (`207, 208, 210, 423, 456, 507, 508`) have no
       real export; Tier 1 would have generated a call to a nonexistent
       `@ApiMultiStatusResponse`-shaped decorator for any of them, throwing a
       `TypeError` the moment the fixed file runs — invisible to `tsc --noEmit`,
       invisible even to a naive "call every decorator once in isolation" smoke
       test (which was tried and passed anyway; see `test/integration/
fix-decorator-runtime.test.ts`'s module doc for why). Fixed via a new
       `UNEXPORTED_SHORTHAND_STATUSES` set consulted by `shorthandDecoratorForStatus`
       (`cli/fix/status-text.ts`), which now falls back to generic `ApiResponse`
       for those 7; drift-tested in both directions by `nest-exceptions-drift.test.ts`.
       Also proved (same test file) that STACKING multiple inserted decorators on
       one method, and inserting alongside a PRE-EXISTING hand-written one,
       correctly accumulate `Reflect` metadata rather than clobbering — the two
       shapes Tier 1 actually produces in practice, as opposed to one decorator
       applied to an isolated dummy class per call.
3. [x] Tier 2 implemented directly (2026-08-08), collapsing the planned
       "spike against 2–3 external repos, then decide" into one pass: the two
       fixtures §10.3 already specified (a class resolving cleanly through
       `Promise<T>`, and an interface-typed union that must fall back) are the
       validation evidence, built locally rather than re-derived from a fresh
       Ever Gauzy clone. Implementation: `core/resolve-response-type.ts`
       (`resolveSuccessResponseType` — the two gates, pure, no `fs`/`checker`
       mutation) plus `cli/fix/plan.ts` (`resolveTier2`, gated on `finding`
       being success-sourced AND a `ts.TypeChecker` being supplied —
       `buildFixPlan`'s `checker` param is optional, so every existing Tier 1
       call site/test is unaffected) and `cli/fix/apply.ts` (`ensureDtoImport`:
       reuses an existing same-module import of the exact class, merges into a
       mergeable declaration, otherwise adds a fresh one; same-file DTOs need no
       import at all; a colliding local name gets a numbered alias). One
       difference from the written design: gate-failed cases are NOT wired to a
       new `documented-status-untyped` opt-in rule (never built) — instead
       `FixEntry.typeSkippedReason` carries the reason and the CLI's `--fix`/
       `--fix-dry-run` summary prints a `typed N / untyped M` count, satisfying
       §10.3's "tell the user, don't just drop it" without standing up a whole
       new rule surface for a first cut.
4. [x] Tier 2 validated end-to-end against a fresh `ever-co/ever-gauzy`
       clone (2026-08-08, `packages/core`, `tsconfig.lib.json`): 554 findings
       (matching the §10.0 baseline exactly), `--fix-dry-run` then `--fix`
       wrote 554/554 insertions (of which 18 typed, 289 untyped-fallback per the
       `typed N / untyped M` summary — this breakdown counts only success-status
       Tier 2 findings, not the full 554), re-running the detector afterward hit 0
       findings, a second `--fix` run was a clean no-op (idempotent), and
       `tsc --noEmit` on the fixed tree passed with zero diagnostics. Two real
       bugs found and fixed in this pass, both in `cli/fix/apply.ts` and both
       regression-tested under `test/fixtures/fix-tier2-classic-resolution/`
       (a project shaped like Ever Gauzy's own `"moduleResolution": "node"`,
       `"module": "commonjs"` config — `fix-tier2`'s own fixture project uses
       `nodenext` throughout and so exercises neither):
   - `computeRelativeImportSpecifier` appended `.js` to every cross-file DTO
     import unconditionally, on the assumption every consumer uses
     `nodenext`/`node16` resolution. Ever Gauzy (`moduleResolution: node`,
     zero `.js`-suffixed relative imports anywhere in the repo) does not:
     the appended `.js` both failed to match the DTO's actual,
     already-present extensionless import (so `ensureDtoImport` added a
     redundant SECOND import under a colliding `Widget2`-style alias
     instead of reusing the first) and named a module specifier that
     doesn't resolve under classic Node resolution — a real `TS2307` had
     the output been compiled, not merely a cosmetic duplicate. 12 of the
     18 Tier 2 typed insertions in the real run hit this. Fixed by sniffing
     the target file's own import-extension convention
     (`relativeImportsUseExtension`, same pattern as the existing
     indentation/newline sniffing) instead of assuming one, and by matching
     existing imports for reuse extension-agnostically
     (`stripKnownExtension`) so `'./x'` and `'./x.js'` are recognized as
     the same import regardless of which style is generated.
   - `applyFixesToFile` resolved each method's `pos` interleaved with
     mutating the file, relying on descending-position processing order to
     keep not-yet-resolved `pos`s ahead of every insertion. That invariant
     covered decorator inserts (which only shift positions after the
     insertion point) but not Tier 2's `ensureDtoImport`, which lands its
     new import near the TOP of the file regardless of which method
     triggered it — so fixing a later (higher-pos) method's typed response
     could shift an earlier (lower-pos) method's still-unresolved `pos` out
     from under it, reported as `'method not found (handler moved or
removed since analysis)'` for a handler that had, in fact, not moved.
     Silently dropped 3 real, still-valid findings across 2 files in the
     Ever Gauzy run. Fixed by resolving every `MethodDeclaration` reference
     in one pass over the pristine, unmutated tree before any insertion or
     import runs, removing the ordering dependency instead of re-deriving a
     new ranking that would hold.
5. [x] Shipped unconditionally rather than gated on spike results (see 3) —
       the gate-fires-usefully-often question stays open pending real usage;
       worth revisiting once the tool has run against more than the two local
       fixtures.
