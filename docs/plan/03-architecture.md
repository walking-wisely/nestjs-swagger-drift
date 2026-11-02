> Part of the [nestjs-swagger-drift implementation plan](../../PLAN.md).
> Section numbers are stable — 200+ code comments cite `PLAN §3`.

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
  | { kind: 'throw'; node: ts.Node; exception: string } // direct throw in handler
  | {
      kind: 'service-throw';
      node: ts.Node;
      exception: string; // via a called method
      via: string[];
    } // call path, e.g. ['UserService.findOne']
  | { kind: 'implicit'; node: ts.Node; reason: 'validation-pipe' | 'guard' | 'success' };

interface ProducibleStatus {
  status: number | 'unknown';
  sources: StatusSource[];
}

interface DocumentedStatus {
  status: number;
  decorator: string; // 'ApiNotFoundResponse'
  node: ts.Node; // for reporting / autofix anchoring
  level: 'method' | 'class';
}

type Finding =
  | {
      rule: 'undocumented-status';
      status: number;
      handler: HandlerInfo;
      sources: StatusSource[];
      node: ts.Node;
    }
  | { rule: 'documented-but-unreachable'; status: number; handler: HandlerInfo; node: ts.Node } // opt-in, off by default
  | { rule: 'unresolvable-status'; handler: HandlerInfo; node: ts.Node; detail: string }; // opt-in, off by default
```

`HandlerInfo` carries `{ className, methodName, httpMethod, path, node }` so the
message can read `POST /users → UserController.create`.
