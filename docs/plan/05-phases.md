> Part of the [nestjs-swagger-drift implementation plan](../../PLAN.md).
> Section numbers are stable — 200+ code comments cite `PLAN §5`.

---

## 5. Phases

### Phase 0 — Scaffold (0.5 day)

TypeScript, `tsup` or plain `tsc` for build, `vitest`, ESLint + Prettier,
`.editorconfig`, MIT license, `package.json` with `typescript` as a peer dep.
CI: GitHub Actions running build + test on Node 20/22/24.
**Exit:** `npm test` green on an empty suite.

### Phase 1 — Read-only skeleton (1 day)

`ts.Program` from a tsconfig; discover `@Controller` classes and their HTTP
handlers; print `METHOD /path → Class.method` for a fixture project.
**Exit:** correct route table for a 3-controller fixture, including
class-level path prefixes and `@Get(':id')` params.

### Phase 2 — Direct throws + documented decorators + diff (2 days)

§4.1a, §4.3, §4.4. Built-in exception table only. No call graph.
**Exit:** the tool finds a real undocumented `404` in a fixture and exits `1`.
This is the first genuinely useful commit.

### Phase 3 — Call graph + custom exceptions (3–4 days)

§4.1b, §4.2. Memoization. Depth limit. Cycle guard.
**Exit:** run against a real NestJS repo (one of your own, or a large OSS one
like `nestjs/nest`'s sample apps or `amplication`) with **zero false positives**.
Zero is the bar; anything else means tightening §4.2's unknown handling.

> **Exit-code convention, established in Phase 1.** `0` must mean "the checker
> verified what it could and there is nothing to flag." A zero-result run reached
> because `@nestjs/common` itself could not be resolved is a different epistemic
> state — "I don't know" — and gets its own code, `2` (`EXIT_COULD_NOT_ANALYSE`),
> fired only when zero handlers were found _and_ an unresolved-module diagnostic
> was seen. Folding that into `0` is the silent-green failure this tool exists to
> prevent. Phase 4's "found drift" code must be distinct from both.

### Phase 4 — CLI polish (1–2 days)

`npx nestjs-swagger-drift [paths]`, flags: `--project`, `--reporter
pretty|json`, `--max-depth`, `--fail-on`, `--ignore`, per-rule enable/disable.
Inline suppression comments: `// swagger-drift-disable-next-line 404`.
Finding paths are currently relative to `cwd`, which degrades to
`../../../..` when analysing a project elsewhere; make the base directory the
tsconfig's directory, or make it configurable.
Config file: `swagger-drift.config.{ts,json}` — but keep it optional; the
zero-config path must work.
**Exit:** usable in CI on a real repo.

### Phase 5 — Hardening (2–3 days)

Implicit codes (§4.1c) behind flags. `documented-but-unreachable` rule.
Perf pass on a 500-file project (target: under ~10s warm). Docs + README with
before/after examples.
**Exit:** v0.1.0 published to npm.

### Phase 6 — ESLint plugin (1–2 days)

`nestjs-swagger-drift/eslint` (subpath export, not a separate package —
see §1), flat-config only (`recommended` config export). One rule:
`nestjs-swagger-drift/documented-status-codes`, options
mirroring the CLI's. `RuleTester` suite. Adapter is:
`getParserServices` → `esTreeNodeToTSNodeMap.get(node)` → `analyzeHandler` →
`context.report({ node, messageId, data })`.
**Exit:** plugin catches the same findings as the CLI on the same fixtures.

### Phase 7 — Autofix (stretch)

Insert the missing `@ApiNotFoundResponse({ description: '...' })` above the
handler. High-value, and the reason ESLint is worth shipping at all — but only
attempt once findings are trustworthy. A wrong autofix is much worse than a
wrong warning. Full tiered design, validated against a real 554-finding run
on `ever-co/ever-gauzy`: see §10.

**Rough total to v0.1.0: ~10–13 focused days.** Phase 3 is where it either works
or doesn't; budget slack there.
