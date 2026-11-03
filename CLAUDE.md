# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Static analysis for NestJS controllers: it follows `throw` statements through
handler code (and, bounded, through called services) to work out which HTTP
status codes a handler can actually produce, maps exception classes to status
codes, and diffs that against what `@ApiResponse`-family decorators document.
Ships as both a CLI and a type-aware ESLint rule sharing the same core engine.

Full design, phases, and rationale live in [`PLAN.md`](./PLAN.md), split into
[`docs/plan/`](./docs/plan/). **Section numbers in `PLAN.md` are cited from
code comments** (`PLAN §3`, `PLAN §10.2`, …) — if you renumber a section,
grep for `PLAN §<n>` across `src/` and `test/` and update the references, or
don't renumber.

## Commands

```sh
npm test                 # vitest run — the full suite
npm run test:watch       # vitest watch mode
npm run test:perf        # separate config (vitest.perf.config.ts); slow synthetic 500-file benchmark, not run in normal `npm test`
npm run typecheck        # tsc --noEmit
npm run lint             # eslint .
npm run format           # prettier --write .
npm run build            # tsup
```

Run a single test file or test:

```sh
npx vitest run test/unit/resolve-status.test.ts
npx vitest run -t "name of the test"
```

CI (`.github/workflows/ci.yml`) runs `typecheck` → `lint` → `build` once, then
`npm test` across a Node LTS matrix. There's no separate `test:integration`
split — `test/unit/`, `test/integration/`, and `test/eslint/` all run under
plain `npm test`; only `test/perf/` is excluded from it.

## Architecture

```
src/
  core/       # analysis engine — the shared logic behind both CLI and ESLint rule
  cli/        # arg parsing, tsconfig → ts.Program, reporters (pretty/json), autofix (cli/fix/)
  eslint/     # thin adapter: one rule wrapping core/analyze.ts, no logic of its own
```

**Hard rule enforced by convention (see `docs/plan/03-architecture.md`):**
nothing under `src/core/` may import from `cli/` or `eslint/`, touch
`process`/`fs`/`console`, or throw for user-facing errors — it returns
`Finding[]`, always. `core/analyze.ts`'s `analyzeHandler()` is the one public
entry point both the CLI and the ESLint rule call into.

Core data flow: `cli/discover.ts` finds `@Controller` classes/handlers in a
`ts.Program` → `core/analyze.ts` resolves each handler's thrown statuses
(`core/thrown.ts`, `core/resolve-status.ts`, `core/call-graph.ts` for
cross-method traversal) and documented statuses (`core/documented.ts`,
`core/decorators.ts`) → diffs them into `Finding[]` → a `cli/report/*`
reporter or the ESLint rule renders them.

Analysis is type-aware — it needs a real `ts.Program` (built from the
target project's own `tsconfig.json`) to resolve calls across files, so
tests build fixture projects rather than mocking the type checker.

### Autofix (`src/cli/fix/`)

Two tiers, detailed in `docs/plan/10-autofix.md`:
- **Tier 1**: insert missing `@ApiResponse`-family decorators for
  known/resolvable statuses.
- **Tier 2**: type-aware — also infers and wires up the success response
  type (`@ApiResponse({ type: Dto })`) from the handler's return type.

`cli/fix/plan.ts` computes a fix plan, `cli/fix/apply.ts` applies it via
ts-morph, `cli/fix/format-diff.ts` renders a `--fix-dry-run` preview.

### Tests (`test/`)

- `test/fixtures/<name>/` — small self-contained NestJS-shaped projects
  (own `tsconfig.json`, `src/`, ambient `types/*.d.ts` standing in for
  `@nestjs/common`/`@nestjs/swagger` so fixtures don't need the real
  packages installed), each usually paired with an `expected.json` of
  findings. Naming maps to what's under test: `status-diff/`,
  `implicit-codes/`, `no-false-positives/`, `fix-tier1/`, `fix-tier2/`,
  `fix-tier2-classic-resolution/`, `edge-cases/`, etc. — add a new fixture
  directory rather than growing an existing one when testing an unrelated
  behavior.
- `test/unit/` — one core module at a time, in-memory (`test/helpers/in-memory-program.ts`
  builds a throwaway `ts.Program` from source strings instead of a fixture
  directory).
- `test/integration/` — CLI/analyze run end-to-end against a fixture directory.
- `test/eslint/` — `@typescript-eslint/rule-tester` suites for the ESLint rule,
  plus an equivalence test asserting the ESLint rule and the CLI agree on
  the same fixtures.
- `test/perf/` — `scripts/gen-perf-fixture.ts` generates a synthetic
  500-file project; only run via `npm run test:perf`.

## Known constraints worth knowing before changing behavior

- This is deliberately a syntactic tool, not semantic: it catches checks that
  *exist but aren't documented*, not checks that *should exist but were never
  written*. Don't add heuristics that try to infer intent.
- `peerDependencies` requires the *consuming* project's own TypeScript
  install (not a bundled copy) so analysis matches that project's real
  `tsconfig.json`/compiler target — don't add `typescript` as a direct
  dependency.
- `--ignore` glob matching (`src/cli/ignore.ts`) has one non-standard rule
  layered on picomatch: a pattern with no `/` matches that path segment at
  any depth (`.gitignore`-style), and a `**` that isn't a standalone segment
  degrades to a plain `*` — see the README's ignore-glob table before
  changing matching behavior.
