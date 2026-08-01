# nestjs-swagger-drift — implementation plan

> Renamed 2026-07-30 from `nestjs-endpoint-doctor`. See §1.1 — the existing
> `nestjs-doctor` package made the original name a collision risk.

> Static analysis for NestJS controllers: every HTTP status code the handler can
> actually produce must be documented with a `@ApiResponse`-family decorator.
>
> Origin: `Vault/ideas/code-analysis-tool-that-would-help-with-keepin.md`

---

## 0. The one-line thesis

AI-generated (and human-generated) NestJS endpoints throw exceptions that never
make it into Swagger. The mapping *thrown exception class → HTTP status code* is
deterministic in NestJS, so a linter can diff **what the code can throw** against
**what the decorators claim** and fail CI on the delta.

Scope boundary, stated up front: this catches *checks that exist but aren't
documented*. It does **not** catch *checks that should exist but were never
written* — that's a semantic problem, not a static one, and belongs to a
different tool.

---

## 1. Product shape

Three deliverables, in this order:

| # | Deliverable | Package name | When |
|---|---|---|---|
| 1 | Analysis engine | `nestjs-swagger-drift/core` (subpath export) | Phase 1–3 |
| 2 | CLI | `nestjs-swagger-drift` | Phase 4 |
| 3 | ESLint plugin | `eslint-plugin-nestjs-swagger-drift` | Phase 6 |

Both npm names were unregistered as of 2026-07-30.

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
*and* extracts `@ApiResponse` status numbers. Both halves of our diff already sit
in the same data structure.

What it does **not** have (verified by grep across the package):

- No exception-class → status-code mapping. It stores the class *name* string
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
  only**: does the handler have *any* `@ApiResponse*` decorator. No status or
  exception analysis. This is the current state of the art, and it is much weaker
  than ours — but it's also the natural home a competitor would add ours to.
- **`@nanogiants/nestjs-swagger-api-exception-decorator`** — *runtime*
  `@ApiException(NotFoundException)` that derives the OpenAPI response from the
  exception class. Adjacent, not competing: it makes documenting cheap but still
  requires you to remember. It cannot tell you what you forgot. Its
  exception→status logic is a good reference for our table, and we should treat
  `@ApiException(...)` as a *documented* source to avoid false positives for its
  users.
- Searches for tools diffing thrown-exception status codes against
  `@ApiResponse` returned nothing. The wedge is unclaimed.

**Why the rename:** `nestjs-endpoint-doctor` vs `nestjs-doctor` is one word
apart, both NestJS static-analysis CLIs over the TS AST, surfacing in the same
searches. Users would reasonably assume a fork, plugin, or typosquat. The name
was free on npm — availability was never the problem, confusability was.
`nestjs-swagger-drift` names the *check* (docs drifting out of sync with code)
rather than the genre.

Worth stealing from `nestjs-doctor`'s graph design: the `GuardThrow` merge for
the ubiquitous `const x = await find(); if (!x) throw new NotFoundException()`
idiom; `branchGroupId`/`branchKind` for conditional throws; and an explicit
truncation flag on the traversal so it degrades honestly instead of hanging.

---

## 2. The two questions you asked, answered first

### 2.1 Will making the ESLint plugin later be complicated?

**No — provided one architectural constraint is honored from commit #1.**

The constraint: **the core analysis must be a pure function over a single
controller method node plus a type checker.**

```ts
analyzeHandler(method: ts.MethodDeclaration, ctx: AnalysisContext): Finding[]
```

Not `analyzeProject(dir)`. Not anything that prints, walks the filesystem, or
holds global state. `analyzeProject` exists, but only as a thin loop *on top of*
`analyzeHandler`.

Why this matters: ESLint's execution model is **one file at a time, report
anchored to a node in the file currently being linted**. A CLI's natural model is
"walk everything, build a report". These are only incompatible if you write the
engine in the CLI's shape. If the unit of analysis is one handler, both drivers
are trivial adapters:

- **CLI driver:** `ts.createProgram` → for each source file → for each
  `@Controller` class → for each handler → `analyzeHandler` → format & print.
- **ESLint driver:** rule listener on `MethodDefinition` → map the ESTree node to
  its `ts.Node` → `analyzeHandler` → `context.report()`.

What ESLint *does* need that the CLI doesn't:

1. **Type-aware linting enabled.** The rule needs `program` + `TypeChecker` to
   resolve service calls across files. That means users must configure
   `parserOptions.projectService: true` (typescript-eslint v8+) or
   `project: './tsconfig.json'`. This is a documentation/config burden on the
   user, not an implementation problem — most NestJS repos already run
   `typescript-eslint` with type-aware rules.
2. **Cross-file reads are fine.** A common misconception is that ESLint rules
   can't do cross-file analysis. They can't *report* into another file, and they
   can't accumulate "state across all files", but reading another file's AST via
   the shared `ts.Program` is completely normal — that's how
   `no-floating-promises` and friends work. Our reports always anchor to the
   controller method, which is in the current file. No conflict.
3. **Caching.** Per-service-method throw sets should be memoized in a
   `WeakMap<ts.Program, Cache>` so re-linting 200 controllers doesn't re-walk
   `UserService` 200 times. Needed for the CLI too; just more visible in ESLint.
4. **A `RuleTester` test suite** in addition to the engine's own tests. Mostly
   mechanical.

Estimated cost of the ESLint adapter *given a clean core*: **1–2 days.** Given a
core tangled with CLI concerns: a rewrite.

### 2.2 Should we start as an ESLint plugin right now?

**No. Start with the engine + CLI. Design for ESLint, don't build it yet.**

Reasoning:

- The risky, unknown part is the *detection logic* (call-graph traversal, custom
  exception status extraction, decorator parsing). That's where 90% of the
  iteration will happen.
- Iterating on detection is dramatically faster against a CLI you can point at a
  fixture directory and diff the output of, than against `RuleTester` cases where
  every experiment needs a flat-config + tsconfig + fixture-project scaffold.
- ESLint pins you early to its diagnostics model (one message, one node, one
  fix). Some findings here are naturally *aggregate* ("this handler is missing 3
  codes"), and you want to discover the right shape before freezing it.
- There is no lock-in cost to deferring, because of §2.1's constraint.

Counter-consideration, honestly stated: if the *only* distribution you ever want
is ESLint, building the CLI is ~2 days of work you'd eventually delete. I'd keep
it anyway — the CLI is the better demo, the better CI story for repos that don't
run type-aware ESLint, and the better debugging tool for the engine forever.

### 2.3 Will `ts-morph` work with ESLint in the long run?

**It technically works, but I recommend not betting the core on it.**

The mechanism, if you want it: typescript-eslint hands you a real `ts.Program`
via `ESLintUtils.getParserServices(context)`, and ts-morph can wrap a raw node:

```ts
import { createWrappedNode } from 'ts-morph'
const services  = ESLintUtils.getParserServices(context)
const tsNode    = services.esTreeNodeToTSNodeMap.get(esNode)
const wrapped   = createWrappedNode(tsNode, {
  typeChecker:     services.program.getTypeChecker(),
  compilerOptions: services.program.getCompilerOptions(),
})
```

Caveats that make this a friction point rather than a clean path:

- `createWrappedNode` produces a node in a **detached, manipulation-disabled**
  ts-morph project. Any mutating API throws. Fine for us (we're read-only), but
  it means half of ts-morph's value proposition is gone.
- Project-level ts-morph APIs (`project.getSourceFiles()`, `.save()`,
  `findReferences` in some configurations) are unavailable or unreliable on
  wrapped nodes. You're left with roughly the raw compiler API surface, wearing a
  nicer coat.
- You'd be running ts-morph's wrapper allocation on top of a Program ESLint
  already built — pure overhead inside a hot lint loop.
- It's an extra ~2MB dep in a plugin whose peer is already `typescript`.

**Decision: core is written against the raw `typescript` compiler API**
(`ts.Node`, `ts.TypeChecker`, `ts.Symbol`). The operations we need are narrow —
read decorators, find `ThrowStatement`s, resolve a call expression to its
declaration, read a class's `extends` clause. That's a few hundred lines of raw
API, and it makes the ESLint adapter a zero-impedance fit.

`ts-morph` stays allowed in **one place only**: the CLI's program-construction
and file-discovery layer, and in test fixtures/scratch scripts, where its
ergonomics genuinely save time and ESLint never looks. Even there, plain
`ts.createProgram` + `tsconfig` parsing is ~40 lines, so it may not be worth the
dependency at all. Start without it; add it only if program setup gets painful.

> If this decision is ever revisited: the tell that it was wrong is finding
> yourself hand-rolling symbol-resolution helpers that ts-morph already has. The
> tell that it was right is the ESLint adapter being under 100 lines.

---

## 3. Architecture

```
src/
  core/
    types.ts            # Finding, HandlerInfo, StatusSource, AnalysisContext
    nest-exceptions.ts  # built-in NestJS exception class → status code table
    decorators.ts       # read @Controller/@Get/@ApiResponse/... off a node
    documented.ts       # documented status codes for a handler (incl. class-level)
    thrown.ts           # thrown/producible status codes for a handler
    resolve-status.ts   # exception expression → status code (built-in/custom/unknown)
    call-graph.ts       # bounded traversal into called methods, memoized
    analyze.ts          # analyzeHandler() — THE public entry point
  cli/
    index.ts            # arg parsing
    program.ts          # tsconfig discovery → ts.Program
    discover.ts         # find @Controller classes + handlers in a Program
    report/
      pretty.ts
      json.ts
      sarif.ts          # (later) GitHub code-scanning
  eslint/               # Phase 6 — adapter only, no logic
    index.ts            # plugin export + configs
    rules/
      documented-status-codes.ts
test/
  fixtures/             # small NestJS-shaped projects, each with expected.json
  unit/
  eslint/               # RuleTester suites (Phase 6)
```

**Hard rule:** nothing under `core/` may import from `cli/` or `eslint/`, touch
`process`, `fs`, or `console`, or throw for user-facing errors (return Findings).

### 3.1 Core data model

```ts
type StatusSource =
  | { kind: 'throw';        node: ts.Node; exception: string }         // direct throw in handler
  | { kind: 'service-throw'; node: ts.Node; exception: string;         // via a called method
                             via: string[] }                            // call path, e.g. ['UserService.findOne']
  | { kind: 'implicit';     node: ts.Node; reason: 'validation-pipe' | 'guard' | 'success' }

interface ProducibleStatus {
  status: number | 'unknown'
  sources: StatusSource[]
}

interface DocumentedStatus {
  status: number
  decorator: string        // 'ApiNotFoundResponse'
  node: ts.Node            // for reporting / autofix anchoring
  level: 'method' | 'class'
}

type Finding =
  | { rule: 'undocumented-status'; status: number; handler: HandlerInfo;
      sources: StatusSource[]; node: ts.Node }
  | { rule: 'documented-but-unreachable'; status: number; handler: HandlerInfo;
      node: ts.Node }                                    // opt-in, off by default
  | { rule: 'unresolvable-status'; handler: HandlerInfo;
      node: ts.Node; detail: string }                    // opt-in, off by default
```

`HandlerInfo` carries `{ className, methodName, httpMethod, path, node }` so the
message can read `POST /users → UserController.create`.

---

## 4. The checks

### 4.1 Producible status codes — how they're derived

**a. Direct `throw` in the handler body.**
Walk the body for `ThrowStatement`. Resolve the thrown expression:

- `new NotFoundException(...)` → look up identifier's symbol → is it from
  `@nestjs/common`? → table lookup → `404`.
- `new SomeCustomException(...)` → §4.2.
- `throw err` (identifier) → resolve declared type; if it's a known exception
  type, use it; else `unknown`.
- Rethrow inside `catch` → same handling, but note it in the source path.

**b. One level into called methods (V1).**
For each `CallExpression` in the handler body whose callee resolves to a method
declaration *inside the program* (i.e. not `node_modules`), recurse into that
method's body and collect its throws. Depth is configurable
(`maxDepth`, default `2` — service, then repository, which is where the vast
majority of NestJS throws live). Guard with a `visited` set for recursion.

This is the single most valuable check and also the main perf cost. Memoize
`ts.Symbol → ProducibleStatus[]` in a `WeakMap` keyed on the Program.

**c. Implicit codes NestJS produces without an explicit throw.**
Off by default in V1, opt-in flags later:

- `400` when a handler parameter's type is a DTO class with `class-validator`
  decorators and a global/route `ValidationPipe` is plausible.
- `401`/`403` from `@UseGuards(...)` — the guard's own throws are resolvable with
  the same machinery, so this is nearly free once (b) works.
- `2xx` success code: `200` for most, `201` for `@Post`, or whatever
  `@HttpCode(n)` says. This one *is* on by default — an endpoint documenting no
  success response at all is the most common miss.

### 4.2 Custom exception status resolution

Ordered strategies, first hit wins:

1. Class `extends` a built-in NestJS exception → inherit its code.
   (`class UserNotFound extends NotFoundException` → `404`.) Walk the whole
   `extends` chain.
2. Class extends `HttpException` and its constructor calls
   `super(msg, 409)` with a **numeric literal** → `409`.
3. `super(msg, HttpStatus.CONFLICT)` — resolve the enum member to its value via
   the checker (`checker.getConstantValue`). Cheap and very common; worth doing
   in V1.
4. Constructor takes the status as a parameter with a default literal → use the
   default, flag as low-confidence.
5. Otherwise → `unknown`. Reported only under the opt-in
   `unresolvable-status` rule, never as a false `undocumented-status`.

Two clarifications found while implementing (2026-08-01), because the list
above reads as five independent strategies when steps 1–4 actually interact:

- **Nearest wins.** In a chain like `A extends B extends HttpException` where
  `A`'s constructor passes an explicit literal and `B`'s only has a default,
  the status is resolved by walking *down* from the instantiated class and
  taking the nearest explicit `super(msg, …)` literal. An explicit argument
  always beats an inherited default.
- **Only `HttpException` gets constructor inspection.** The concrete built-ins
  (`NotFoundException` et al.) take only a message — their real constructors
  never accept a status — so "extends a built-in *and* calls `super(msg, 409)`"
  is not a meaningful case for them. Ancestors found in the built-in table are
  treated as fixed and unoverridable; only a chain terminating at
  `HttpException` itself is routed through steps 2–4.

**Bias: silence over noise.** An unresolvable status must never manufacture a
finding under the default config. The tool dies the moment a NestJS team gets
one false positive per file.

### 4.3 Documented status codes

Collect from the handler method **and** its enclosing class (class-level
`@ApiResponse` applies to all handlers):

- Generic: `@ApiResponse({ status: 404, ... })` — read the numeric literal, or
  resolve `HttpStatus.NOT_FOUND`.
- Shorthands: `@ApiOkResponse`, `@ApiCreatedResponse`, `@ApiNotFoundResponse`,
  `@ApiBadRequestResponse`, `@ApiUnauthorizedResponse`, `@ApiForbiddenResponse`,
  `@ApiConflictResponse`, `@ApiUnprocessableEntityResponse`,
  `@ApiInternalServerErrorResponse`, … — full table in `nest-exceptions.ts`,
  generated from `@nestjs/swagger`'s exported decorator names so it can't drift.
- `@ApiDefaultResponse` → treat as a wildcard that satisfies nothing specific
  (configurable: `treatDefaultAsWildcard`).
- Composed/custom decorators (`applyDecorators(ApiNotFoundResponse(), ...)`) —
  V1 gap; document it. V2: resolve the decorator factory one level and inspect
  what it composes.

### 4.4 The diff

`producible \ documented` → `undocumented-status` findings, one per status code,
each carrying every source that can produce it (so the message can show the
call path).

Example output:

```
src/users/users.controller.ts:42:3  error
  POST /users (UserController.create) is missing @ApiResponse for:
    409 ConflictException
       └ UsersService.create  src/users/users.service.ts:88
    404 NotFoundException
       └ UsersService.create → OrgRepository.findOne  src/org/org.repository.ts:31
```

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
> fired only when zero handlers were found *and* an unresolved-module diagnostic
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
`eslint-plugin-nestjs-swagger-drift`, flat-config only (`recommended` config
export). One rule: `nestjs-swagger-drift/documented-status-codes`, options
mirroring the CLI's. `RuleTester` suite. Adapter is:
`getParserServices` → `esTreeNodeToTSNodeMap.get(node)` → `analyzeHandler` →
`context.report({ node, messageId, data })`.
**Exit:** plugin catches the same findings as the CLI on the same fixtures.

### Phase 7 — Autofix (stretch)
Insert the missing `@ApiNotFoundResponse({ description: '...' })` above the
handler. High-value, and the reason ESLint is worth shipping at all — but only
attempt once findings are trustworthy. A wrong autofix is much worse than a
wrong warning.

**Rough total to v0.1.0: ~10–13 focused days.** Phase 3 is where it either works
or doesn't; budget slack there.

---

## 6. Known gaps (document them, don't hide them)

- Guards/interceptors/filters not analyzed by default (Phase 5, opt-in).
- Exception filters that *remap* status codes (`@Catch()`) will make findings
  wrong. Needs a config escape hatch: `ignoreStatuses` / per-file ignores.
- Dynamically computed status (`throw new HttpException(msg, someVar)`) →
  `unknown`, silent by default.
- Composed decorators via `applyDecorators` (V1 gap). Two distinct cases: a
  composed `@ApiResponse` (§4.3), and a composed *route* decorator — the latter
  is worse, because a controller or handler declared only through a composed
  factory is invisible to discovery entirely (nothing is literally named
  `Controller`/`Get`), so the endpoint is silently absent rather than merely
  under-documented. Common in real Nest code.
- **Inherited handlers are not discovered.** NestJS ≥8 walks the whole prototype
  chain, so `class Derived extends Base` inherits `Base`'s decorated routes.
  Discovery is currently own-members-only. Generic CRUD base controllers are a
  common pattern, and in Phase 2 this becomes silent *under*-reporting of drift.
  Pinned by `test/fixtures/edge-cases/src/derived-controller.ts` so the gap is
  explicit and cannot silently change.
- `@Controller({ version })` and global `setGlobalPrefix()` are not reflected in
  the reported path. Cosmetic while the check is per-handler, but the printed
  route will not match the served URL.
- Alias matching covers named-import aliasing (`import { Get as HttpGet }`) but
  not a renamed default re-export (`export { Controller as default }`).
- Route paths that cannot be statically resolved (a `let`, a function call) are
  flagged `unresolvedPath` and reported with an explicit `<unresolved>` marker
  rather than a confident wrong path. `const` references, string concatenation,
  and template literals interpolating only `const`s *are* resolved via the
  checker's literal types.
- Throws from third-party libraries (Prisma, TypeORM) that Nest maps to 500 —
  out of scope; would need a per-library mapping table.
- Calls inside a thrown expression's own arguments (`throw new X(this.helper())`)
  are not traversed, since the walker does not descend into a `ThrowStatement`'s
  expression. Deliberate and FP-safe; under-collects only.
- A callback's throw reached *through* an otherwise-traversable call
  (`svc.each(() => { throw … })`) is still not collected — the pre-existing
  nested-function gap, now inherited transitively by the call graph.
- Monorepos with multiple tsconfigs — CLI takes `--project` repeatedly; ESLint
  path needs `projectService`.
- **TypeScript 7 is not supported, and this is not a small gap.** TS 7's root
  export is a version-string module; `ts.createProgram` / `ts.TypeChecker` /
  `ts.Node` are gone, with the native port exposing only `unstable/*` subpaths.
  The peer range is therefore `>=5.0.0 <7.0.0`. Supporting TS 7 means retargeting
  the whole core at `typescript/unstable/ast` — effectively a rewrite, and its
  own project. Track upstream stability before attempting it.

---

## 7. Testing strategy

- **Fixture-driven, snapshot-verified.** Each `test/fixtures/<case>/` is a tiny
  NestJS-shaped project plus `expected.json` (the exact Findings). Adding a case
  is copying a folder — this keeps the iteration loop fast in Phase 3.
- **A "no false positives" corpus.** A directory of *correctly documented*
  controllers pulled from real code. The suite asserts the tool reports nothing.
  This is the regression net that keeps the tool trustworthy.
- **Unit tests** for `resolve-status.ts` (the trickiest logic) against
  hand-written class hierarchies.
- **RuleTester** suite in Phase 6, asserting parity with the engine.

---

## 8. Positioning / why this can be real

Nothing does this for NestJS today. `springdoc` generates docs from code (Java),
`buf lint` covers protobuf, `@nestjs/swagger`'s CLI plugin infers *types* but not
*status codes*. The wedge is narrow and the pain is concrete and increasing with
AI-authored endpoints. Small, deterministic, zero-config, CI-shaped — that's a
tool people actually adopt.

Distribution order that maximizes the chance anyone uses it: CLI first (works in
any repo, one command, great README screenshot) → ESLint plugin (meets teams
where they already are) → autofix (the thing that makes it beloved).

---

## 9. Open decisions

- [x] License: **MIT** (decided 2026-07-30).
- [x] Name: **`nestjs-swagger-drift`** (decided 2026-07-30, see §1.1).
- [ ] **Distribution strategy — the big one, deferred to Phase 5/6.** Three
      routes, and the pure-core architecture (§2.1) means the engine is identical
      under all of them, so this genuinely can be decided late:
      1. *Standalone* CLI + ESLint plugin. Full control, hardest distribution.
      2. *Ship as a `nestjs-doctor` custom rule* — it supports `customRulesDir`
         with a `meta`+`check` contract and already exposes `endpointGraph` on
         the analysis context. Instant reach to ~7k weekly users.
      3. *Contribute the rule to `@darraghor/eslint-plugin-nestjs-typed`*, which
         already has a Swagger rule group and the audience.
      Routes 2 and 3 trade the differentiator away — it becomes a feature of
      someone else's product. Not necessarily wrong; decide with real usage data.
- [ ] Package layout: single package with subpath exports vs. monorepo from the
      start. *Lean: single package until Phase 6.*
- [ ] Is `documented-but-unreachable` valuable enough to build? It catches
      copy-pasted decorator blocks, which is a real AI failure mode.
- [ ] Should success-code checking (`@ApiOkResponse` presence) be on by default?
      *Lean: yes — it's the most common miss and has no false-positive risk.*
- [ ] Support `@ApiException(...)` from
      `@nanogiants/nestjs-swagger-api-exception-decorator` as a *documented*
      source (§4.3). Cheap, and avoids false positives for that library's users.
