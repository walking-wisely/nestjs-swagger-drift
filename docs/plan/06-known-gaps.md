> Part of the [nestjs-swagger-drift implementation plan](../../PLAN.md).
> Section numbers are stable — 200+ code comments cite `PLAN §6`.

---

## 6. Known gaps (document them, don't hide them)

- Guards/interceptors/filters not analyzed by default (Phase 5, opt-in).
- Exception filters that _remap_ status codes (`@Catch()`) will make findings
  wrong. Needs a config escape hatch: `ignoreStatuses` / per-file ignores.
- Dynamically computed status (`throw new HttpException(msg, someVar)`) →
  `unknown`, silent by default.
- Composed _route_ decorators via `applyDecorators`. (A composed
  `@ApiResponse` is resolved; see §4.3.) A composed route decorator is worse, because a controller or handler declared only through a composed
  factory is invisible to discovery entirely (nothing is literally named
  `Controller`/`Get`), so the endpoint is silently absent rather than merely
  under-documented. Common in real Nest code.
- **Inherited handlers are not discovered.** NestJS ≥8 walks the whole prototype
  chain, so `class Derived extends Base` inherits `Base`'s decorated routes.
  Discovery is currently own-members-only. Generic CRUD base controllers are a
  common pattern, and in Phase 2 this becomes silent _under_-reporting of drift.
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
  and template literals interpolating only `const`s _are_ resolved via the
  checker's literal types.
- Throws from third-party libraries (Prisma, TypeORM) that Nest maps to 500 —
  out of scope; would need a per-library mapping table.
- Calls inside a thrown expression's own arguments (`throw new X(this.helper())`)
  are not traversed, since the walker does not descend into a `ThrowStatement`'s
  expression. Deliberate and FP-safe; under-collects only.
- A callback's throw reached _through_ an otherwise-traversable call
  (`svc.each(() => { throw … })`) is still not collected — the pre-existing
  nested-function gap, now inherited transitively by the call graph.
- **Call-site arguments only decide literal-driven guards.** A throw under
  `if (flag)` is skipped when every caller on the path passes a literal that
  makes the condition false (omitted optional parameter, `false`, a literal
  default, a flag forwarded through a wrapper). Conditions over anything
  else — a property read, a call, an unbound parameter, a parameter the callee
  reassigns — keep both branches live, so a flag computed at the call site is
  still treated as possibly true. Found via Ever Gauzy's
  `RequestContext.currentUser(throwError?)`, which produced 124 false 401s
  before this (`corpus/ever-gauzy/notes.md`).
- Monorepos with multiple tsconfigs — CLI takes `--project` repeatedly; ESLint
  path needs `projectService`.
- **TypeScript 7 is not supported, and this is not a small gap.** TS 7's root
  export is a version-string module; `ts.createProgram` / `ts.TypeChecker` /
  `ts.Node` are gone, with the native port exposing only `unstable/*` subpaths.
  The peer range is therefore `>=5.0.0 <7.0.0`. Supporting TS 7 means retargeting
  the whole core at `typescript/unstable/ast` — effectively a rewrite, and its
  own project. Track upstream stability before attempting it.
