> Part of the [nestjs-swagger-drift implementation plan](../../PLAN.md).
> Section numbers are stable — 200+ code comments cite `PLAN §1`.

---

## 1. Product shape

Three deliverables, in this order:

| #   | Deliverable     | Package name                                                                    | When      |
| --- | --------------- | ------------------------------------------------------------------------------- | --------- |
| 1   | Analysis engine | `nestjs-swagger-drift/core` (subpath export)                                    | Phase 1–3 |
| 2   | CLI             | `nestjs-swagger-drift`                                                          | Phase 4   |
| 3   | ESLint plugin   | `nestjs-swagger-drift/eslint` (subpath export, not a separate package — see §9) | Phase 6   |

The npm name `nestjs-swagger-drift` was unregistered as of 2026-07-30. §9's
"single package until Phase 6" open question resolved to "single package,
period" — see `src/eslint/index.ts`'s module doc comment for the rationale;
`eslint-plugin-nestjs-swagger-drift` as a standalone package was never
published.

Ship 1+2 as a single package initially (with the core exported from a subpath)
to avoid monorepo overhead before it earns its keep. Split only when the ESLint
plugin lands.

## 1.1 Prior art and why the name changed

Researched 2026-07-30. **The check does not exist anywhere. The plumbing for it
mostly does, inside a fast-moving competitor.**

**`nestjs-doctor`** (RoloBits, MIT, ~7k weekly downloads, 419 commits in 5
months, releases several times a week, VS Code extension + GitHub Action +
`nestjs.doctor` domain) is a 50-rule health-score CLI for NestJS —
security/correctness/architecture/performance/schema. **None of its 50 rules
touch Swagger, status codes, or exception documentation.**

But its `endpoint-graph.ts` (~2,200 lines) already builds most of what Phases
1–3 here budget for: it enumerates handlers into an `EndpointNode` (controller,
HTTP method, route path, return type), traces calls cross-file into services
with a depth bound and a node-count cap, extracts `ThrowStatement` class names,
_and_ extracts `@ApiResponse` status numbers. Both halves of our diff already sit
in the same data structure.

What it does **not** have (verified by grep across the package):

- No exception-class → status-code mapping. It stores the class _name_ string
  only; there is no `NotFoundException`→404 table anywhere.
- No produced-vs-documented diff. **Zero rules consume `endpointGraph`** — it
  feeds only the HTML report and the public Node API.
- Swagger extraction covers only `{ApiOperation, ApiParam, ApiQuery, ApiResponse,
ApiBody}`. The entire shorthand family (`@ApiNotFoundResponse`,
  `@ApiConflictResponse`, `@ApiOkResponse`, …) is unparsed, and `@ApiResponse`
  without an explicit `status` defaults to 200.
- No ESLint plugin, no autofix.

**Treat this as a race, not a gap.** They are one `if` statement and a lookup
table from our idea. Lead with what they'd have to build from scratch: the
exception→status mapping (`extends` chains, `super(msg, 409)`, `HttpStatus.X`),
the full shorthand decorator family, and the autofix.

Other prior art:

- **`@darraghor/eslint-plugin-nestjs-typed`** — the incumbent NestJS ESLint
  plugin. Its `api-method-should-specify-api-response` is a **presence check
  only**: does the handler have _any_ `@ApiResponse*` decorator. No status or
  exception analysis. This is the current state of the art, and it is much weaker
  than ours — but it's also the natural home a competitor would add ours to.
- **`@nanogiants/nestjs-swagger-api-exception-decorator`** — _runtime_
  `@ApiException(NotFoundException)` that derives the OpenAPI response from the
  exception class. Adjacent, not competing: it makes documenting cheap but still
  requires you to remember. It cannot tell you what you forgot. Its
  exception→status logic is a good reference for our table, and we should treat
  `@ApiException(...)` as a _documented_ source to avoid false positives for its
  users.
- Searches for tools diffing thrown-exception status codes against
  `@ApiResponse` returned nothing. The wedge is unclaimed.

**Why the rename:** `nestjs-endpoint-doctor` vs `nestjs-doctor` is one word
apart, both NestJS static-analysis CLIs over the TS AST, surfacing in the same
searches. Users would reasonably assume a fork, plugin, or typosquat. The name
was free on npm — availability was never the problem, confusability was.
`nestjs-swagger-drift` names the _check_ (docs drifting out of sync with code)
rather than the genre.

Worth stealing from `nestjs-doctor`'s graph design: the `GuardThrow` merge for
the ubiquitous `const x = await find(); if (!x) throw new NotFoundException()`
idiom; `branchGroupId`/`branchKind` for conditional throws; and an explicit
truncation flag on the traversal so it degrades honestly instead of hanging.
