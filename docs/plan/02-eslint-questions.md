> Part of the [nestjs-swagger-drift implementation plan](../../PLAN.md).
> Section numbers are stable — 200+ code comments cite `PLAN §2`.

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
holds global state. `analyzeProject` exists, but only as a thin loop _on top of_
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

What ESLint _does_ need that the CLI doesn't:

1. **Type-aware linting enabled.** The rule needs `program` + `TypeChecker` to
   resolve service calls across files. That means users must configure
   `parserOptions.projectService: true` (typescript-eslint v8+) or
   `project: './tsconfig.json'`. This is a documentation/config burden on the
   user, not an implementation problem — most NestJS repos already run
   `typescript-eslint` with type-aware rules.
2. **Cross-file reads are fine.** A common misconception is that ESLint rules
   can't do cross-file analysis. They can't _report_ into another file, and they
   can't accumulate "state across all files", but reading another file's AST via
   the shared `ts.Program` is completely normal — that's how
   `no-floating-promises` and friends work. Our reports always anchor to the
   controller method, which is in the current file. No conflict.
3. **Caching.** Per-service-method throw sets should be memoized in a
   `WeakMap<ts.Program, Cache>` so re-linting 200 controllers doesn't re-walk
   `UserService` 200 times. Needed for the CLI too; just more visible in ESLint.
4. **A `RuleTester` test suite** in addition to the engine's own tests. Mostly
   mechanical.

Estimated cost of the ESLint adapter _given a clean core_: **1–2 days.** Given a
core tangled with CLI concerns: a rewrite.

### 2.2 Should we start as an ESLint plugin right now?

**No. Start with the engine + CLI. Design for ESLint, don't build it yet.**

Reasoning:

- The risky, unknown part is the _detection logic_ (call-graph traversal, custom
  exception status extraction, decorator parsing). That's where 90% of the
  iteration will happen.
- Iterating on detection is dramatically faster against a CLI you can point at a
  fixture directory and diff the output of, than against `RuleTester` cases where
  every experiment needs a flat-config + tsconfig + fixture-project scaffold.
- ESLint pins you early to its diagnostics model (one message, one node, one
  fix). Some findings here are naturally _aggregate_ ("this handler is missing 3
  codes"), and you want to discover the right shape before freezing it.
- There is no lock-in cost to deferring, because of §2.1's constraint.

Counter-consideration, honestly stated: if the _only_ distribution you ever want
is ESLint, building the CLI is ~2 days of work you'd eventually delete. I'd keep
it anyway — the CLI is the better demo, the better CI story for repos that don't
run type-aware ESLint, and the better debugging tool for the engine forever.

### 2.3 Will `ts-morph` work with ESLint in the long run?

**It technically works, but I recommend not betting the core on it.**

The mechanism, if you want it: typescript-eslint hands you a real `ts.Program`
via `ESLintUtils.getParserServices(context)`, and ts-morph can wrap a raw node:

```ts
import { createWrappedNode } from 'ts-morph';
const services = ESLintUtils.getParserServices(context);
const tsNode = services.esTreeNodeToTSNodeMap.get(esNode);
const wrapped = createWrappedNode(tsNode, {
  typeChecker: services.program.getTypeChecker(),
  compilerOptions: services.program.getCompilerOptions(),
});
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
