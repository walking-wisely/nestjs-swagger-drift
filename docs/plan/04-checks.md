> Part of the [nestjs-swagger-drift implementation plan](../../PLAN.md).
> Section numbers are stable — 200+ code comments cite `PLAN §4`.

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
declaration _inside the program_ (i.e. not `node_modules`), recurse into that
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
  `@HttpCode(n)` says. This one _is_ on by default — an endpoint documenting no
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
  the status is resolved by walking _down_ from the instantiated class and
  taking the nearest explicit `super(msg, …)` literal. An explicit argument
  always beats an inherited default.
- **Only `HttpException` gets constructor inspection.** The concrete built-ins
  (`NotFoundException` et al.) take only a message — their real constructors
  never accept a status — so "extends a built-in _and_ calls `super(msg, 409)`"
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
