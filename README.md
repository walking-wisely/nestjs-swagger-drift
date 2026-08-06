# nestjs-swagger-drift

Catch NestJS endpoints whose Swagger docs have drifted from the code.

For every controller handler it works out which HTTP status codes the code can
actually produce — following `throw` statements through your services, mapping
exception classes (including your own) to status codes — then diffs that
against what the `@ApiResponse` decorators claim.

```
src/users/users.controller.ts:42:3  error
  POST /users (UserController.create) is missing @ApiResponse for:
    409 ConflictException
       └ UsersService.create  src/users/users.service.ts:88
    404 NotFoundException
       └ UsersService.create → OrgRepository.findOne  src/org/org.repository.ts:31
```

Deterministic, zero-config, CI-shaped.

**Status: Phase 5 (Hardening) complete.** Route discovery, direct/call-graph
throw resolution, custom exception status resolution, decorator-based
documentation matching, the CLI, and the implicit-codes/opt-in rules below are
all implemented. See [PLAN.md](./PLAN.md) for the full design, scope
boundaries, and prior-art analysis. Publishing to npm (`v0.1.0`) is a manual
step for the maintainer — this repo is not auto-published.

## Scope

This catches checks that **exist but aren't documented**. It does not catch
checks that _should_ exist but were never written — that's a semantic
problem, not a static one.

## Features

- **Route discovery** — `@Controller`/`@Get`/`@Post`/... including class-level
  path prefixes, array-form paths, and aliased imports.
- **Direct throws** (`throw new NotFoundException(...)`) resolved against the
  full `@nestjs/common` exception table.
- **Call-graph traversal** — a handler that calls into a service (and that
  service into a repository, up to `--max-depth`, default 2) is checked for
  the callee's throws too, not just its own. Memoized, so re-analyzing 500
  controllers that share a service doesn't re-walk that service 500 times.
- **Custom exception classes** — `class UserNotFound extends NotFoundException`
  inherits `404`; `class Conflict extends HttpException { constructor() {
  super(msg, 409) } }` resolves the literal (or `HttpStatus.CONFLICT`) it
  passes to `super`.
- **The full `@Api*Response` decorator family** — the generic
  `@ApiResponse({ status })` plus every shorthand (`@ApiNotFoundResponse`,
  `@ApiConflictResponse`, ...), `@ApiDefaultResponse` (optionally a
  wildcard), and `'1XX'`–`'5XX'` status ranges. Class-level decorators (and a
  base class's, up the `extends` chain) apply to every handler.
- **Implicit codes** (below) — a handler's own success status, and two opt-in
  checks for `ValidationPipe` and `@UseGuards(...)`.
- **Two opt-in extra rules**: `documented-but-unreachable` (a documented
  status nothing in the code can produce — usually a copy-pasted decorator
  block) and `unresolvable-status` (a throw whose status couldn't be
  statically determined, surfaced instead of silently dropped).
- **Inline suppression**: `// swagger-drift-disable-next-line [404[, 409]]`
  above a handler or a throw.
- **A config file** (`swagger-drift.config.{json,js,mjs,ts}`), fully optional.

## Installation

```sh
npm install --save-dev nestjs-swagger-drift
```

Peer dependency: `typescript >=5.0.0 <7.0.0` (already a dependency of any
NestJS project).

## CLI usage

```sh
npx nestjs-swagger-drift --project ./tsconfig.json
```

Exits `0` if nothing was found, `3` if it found drift `--fail-on` cares
about, `1` on a usage error (bad flag, missing/unparsable tsconfig or config
file), `2` if it couldn't determine anything at all (zero handlers found
*and* `@nestjs/common` itself couldn't be resolved — "I don't know," not
"there's nothing here").

```
Usage: nestjs-swagger-drift --project <path-to-tsconfig-or-dir> [options]

Options:
  -p, --project <path>        tsconfig.json (or its directory) to analyze. Required
                               unless set via a config file.
      --routes                Print the discovered route table instead of findings.
      --reporter <mode>       "pretty" (default) or "json".
      --max-depth <n>         Call-graph traversal depth (default: 2).
      --fail-on <rules>       "all" (default), "none", or a comma-separated list of
                               rule names that should cause a nonzero exit.
      --ignore <glob>         Exclude matching source files (repeatable).
      --ignore-status <n>     Never report this status code (repeatable).
      --enable-rule <name>    Enable an opt-in rule (repeatable).
      --disable-rule <name>   Disable an opt-in rule (repeatable).
      --treat-default-as-wildcard / --no-treat-default-as-wildcard
      --check-success-response / --no-check-success-response
                               Check for a documented 2xx response (default: on).
      --check-validation-pipe / --no-check-validation-pipe
                               Check for an implicit 400 from a class-validator DTO
                               parameter (default: off).
      --check-guards / --no-check-guards
                               Check @UseGuards(...) classes for implicit 401/403
                               (default: off).
      --base-dir <path>       Base directory for reported file paths
                               (default: the tsconfig's own directory).
      --config <path>         Explicit swagger-drift.config.{json,js,mjs,ts} path.
      --no-config             Skip loading/auto-discovering a config file entirely.
      --audit                 Ignore swagger-drift-disable-next-line directives, so
                               every finding they would otherwise hide is reported.
  -h, --help                  Print this message.
```

Rule names for `--fail-on`/`--enable-rule`/`--disable-rule`:
`undocumented-status`, `documented-but-unreachable`, `unresolvable-status`.

### Config file

`swagger-drift.config.{json,js,mjs,ts}`, auto-discovered in `cwd` (or given
explicitly via `--config`). Every field mirrors a CLI flag 1:1; precedence is
**flag > config file > built-in default**. Fully optional — the zero-config
path (`npx nestjs-swagger-drift --project ./tsconfig.json`) always works.

```json
{
  "project": "./tsconfig.json",
  "reporter": "json",
  "maxDepth": 2,
  "failOn": "all",
  "ignore": ["**/*.spec.ts"],
  "ignoreStatuses": [500],
  "rules": { "documented-but-unreachable": true },
  "checkGuards": true
}
```

## What's on by default vs. opt-in

| Check | Default | Why |
|---|---|---|
| Direct throws, call-graph throws, custom exception classes | **on** | Deterministic — a resolved status is never a guess. |
| 2xx success response (`checkSuccessResponse`) | **on** | Every handler that returns normally produces *some* status; documenting none at all is the single most common miss. `@Redirect()` and `@Res()`/`@Response()` handlers are excluded (see below) rather than asserted a wrong default. |
| `ValidationPipe` implicit 400 (`checkValidationPipe`) | off | A `class-validator`-decorated DTO parameter doesn't prove `ValidationPipe` is actually registered anywhere in the app — this tool can't see that. |
| `@UseGuards(...)` implicit 401/403 (`checkGuards`) | off | A guard is provably *attached*, not provably *throwing* the way this analysis assumes (it could reject without throwing). |
| `documented-but-unreachable` | off | Catches copy-pasted decorator blocks, but needs the full producible set (including the two checks above) to avoid flagging things this run simply didn't verify. |
| `unresolvable-status` | off | Surfaces a throw this tool couldn't pin to a status, instead of silently dropping it — useful for auditing coverage, noisy as a default gate. |

The unifying rule (PLAN's "silence over noise"): nothing that can produce a
false positive under default settings is on by default. `checkSuccessResponse`
is the closest thing to an exception — NestJS always returns *some* status on
a normal return, so a plain handler's implicit success code is never a guess.
It isn't a blanket "no false-positive risk" claim, though: `@Redirect()`
(NestJS defaults a redirect to `302`, not `200`/`201`) and `@Res()`/
`@Response()` (the handler takes over the response object; NestJS's automatic
status-setting doesn't apply) are real shapes where the plain default would be
wrong — `success.ts` detects both and skips emitting an implicit-success
source for them entirely rather than asserting a status it can't back. `@All()`
routes, whose real semantics aren't knowable from the decorator alone, are
skipped the same way unless an explicit `@HttpCode(...)` says otherwise.

## Before / after

The example below is real, reproducible CLI output — `src/users.controller.ts`
and `src/users.service.ts` as shown, analyzed with
`nestjs-swagger-drift --project ./tsconfig.json`. `analyzeHandler` emits one
`Finding` per undocumented status code, and the pretty reporter
(`src/cli/report/pretty.ts`) prints one header block per finding — sorted by
status, so the handler's implicit `200` sorts before its `404` — joined by a
blank line, not stacked under a single shared header.

```ts
// src/users.service.ts
@Injectable()
export class UsersService {
  findOne(id: string): string {
    if (!id) throw new NotFoundException('no user with that id');
    return 'user';
  }
}

// src/users.controller.ts
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.users.findOne(id); // throws NotFoundException if missing
  }
}
```

```sh
$ npx nestjs-swagger-drift --project ./tsconfig.json
src/users.controller.ts:8:3  error
  GET /users/:id (UsersController.findOne) is missing @ApiResponse for:
    200 success
       └ implicit (success)  src/users.controller.ts:8:3

src/users.controller.ts:8:3  error
  GET /users/:id (UsersController.findOne) is missing @ApiResponse for:
    404 NotFoundException
       └ UsersService.findOne  src/users.service.ts:6:14

nestjs-swagger-drift: found 2 finding(s), 2 matched by --fail-on, 0 suppressed.
```

Documenting both:

```ts
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @ApiOkResponse({ description: 'the user' })
  @ApiNotFoundResponse({ description: 'No user with that id' })
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.users.findOne(id);
  }
}
```

```sh
$ npx nestjs-swagger-drift --project ./tsconfig.json
No undocumented status codes found.
```

## The implicit-codes checks, in more detail

- **`checkSuccessResponse`** (`success.ts`) — `200` for most handlers, `201`
  for `@Post()`, or whatever `@HttpCode(n)` overrides it to. An unresolvable
  `@HttpCode` argument (a variable, a computed expression) is silently
  skipped rather than guessed, and so are `@Redirect()`, `@Res()`/
  `@Response()` handlers, and a bare `@All()` (see above).
- **`checkValidationPipe`** (`validation-pipe.ts`) — treats `400` as
  producible when a handler parameter is decorated with `@Body()`/`@Param()`/
  `@Query()` AND its type is a class carrying at least one `class-validator`
  decorator (`@IsString()`, `@IsNotEmpty()`, ...). Inherited DTO base-class
  decorators are not walked — deliberately narrow.
- **`checkGuards`** (`guards.ts`) — resolves each `@UseGuards(SomeGuard)`
  class (method- and class-level), finds its `canActivate`, and recurses into
  it with the same bounded call-graph traversal used for services, collecting
  whatever it throws (typically `UnauthorizedException`/`ForbiddenException`).
- **`documented-but-unreachable`** — scoped to a handler's own METHOD-level
  documented statuses only (a class-level `@ApiResponse` is usually a blanket
  "this whole controller might produce this" statement, not a per-handler
  claim). A documented numeric status not in this run's producible set is
  flagged, UNLESS: it's `500` (out of scope by construction — see PLAN §6);
  it's the handler's own implicit success status (always reachable — NestJS
  always returns something, resolved the same way `checkSuccessResponse`
  would, even when that check is off); or it's `400`/`401`/`403` (the tool
  can never fully verify `ValidationPipe`/guard behavior — see
  `checkValidationPipe`/`checkGuards` above — so these stay exempt
  regardless of whether the corresponding check happens to be enabled).
- **`unresolvable-status`** — reports a handler's own direct throw AND any
  unresolvable throw reached through the call graph whose status
  `resolve-status.ts` couldn't statically pin down. Not suppressed by an
  `@ApiDefaultResponse` wildcard (unlike the two rules above, an
  unresolvable throw has nothing to do with what's documented).

## Performance

A synthetic 500-controller / 2,500-handler project (`scripts/gen-perf-fixture.ts`,
exercised by `npm run test:perf`) analyzes in well under a second warm on
ordinary hardware — comfortably inside PLAN §5's "under ~10s" target.

## License

MIT
