/**
 * The built-in `@nestjs/common` HTTP exception class → status code table,
 * a mirror of the `HttpStatus` enum, and the `@nestjs/swagger` shorthand
 * `@Api*Response` decorator table — all runtime-verified against the real
 * packages (PLAN §2 deliverable 1's "drift risk" note).
 *
 * ## Why this is runtime-verified rather than a real `@nestjs/common`
 * install used directly by the analyzer
 *
 * The obvious way to make these tables impossible to drift from the real
 * packages is to add `@nestjs/common`/`@nestjs/swagger` as devDependencies
 * and write a test that walks their actual exports. The obstacle: every
 * `test/fixtures/**` project resolves `@nestjs/common`/`@nestjs/swagger` via
 * plain Node module resolution (`moduleResolution: "nodenext"`/`"bundler"`,
 * no `paths` override — a `paths` override was tried and doesn't work
 * either, TS falls back to normal resolution when the mapping misses), which
 * walks *up* the directory tree looking for `node_modules/@nestjs/...` —
 * including this package's own root `node_modules`. Installing the real
 * packages there under their real names — even transitively, as
 * peerDependencies of something else — makes `@nestjs/common` resolve
 * inside `test/fixtures/unresolved-module/` and
 * `test/fixtures/unresolved-module-empty/`, which exist specifically to
 * reproduce "this tsconfig genuinely cannot resolve `@nestjs/common`" (see
 * those fixtures' own comments and `test/integration/unresolved-module.test.ts`).
 * That would silently break the exact regression test the Phase 1 review
 * added `EXIT_COULD_NOT_ANALYSE` for.
 *
 * The fix that actually works: install the real packages under npm
 * **aliases** (`nest-common-snapshot`/`nest-swagger-snapshot` in
 * `package.json`'s `devDependencies`, `npm:@nestjs/<x>@^11`), which never
 * creates `node_modules/@nestjs/<x>` under its real name for a bare
 * `@nestjs/<x>` specifier to find — verified directly. The one thing that
 * *does* create it is npm 7+'s automatic peer-dependency installation
 * (`@nestjs/swagger` peer-depends on `@nestjs/common`/`@nestjs/core` under
 * their real names, regardless of what the top-level alias is called) —
 * handled by this repo's root `.npmrc` (`legacy-peer-deps=true`), which
 * reverts to npm 6-era behavior and never auto-installs peers. See
 * `.npmrc`'s own comment; `test/unit/nest-exceptions-drift.test.ts`'s module
 * doc has the runtime-verification mechanics.
 *
 * `BUILTIN_HTTP_EXCEPTIONS` and `HTTP_STATUS_ENUM_VALUES` are still literal
 * tables here — they can't be *derived* from anything, only checked against
 * the real thing at test time (that's what
 * `test/unit/nest-exceptions-drift.test.ts` does; if it goes red, this
 * table is stale). `SHORTHAND_RESPONSE_DECORATORS`, by contrast, genuinely
 * *is* derived (see `shorthandResponseDecoratorName` below) — `@nestjs/
 * swagger` generates its shorthand decorators mechanically from
 * `HttpStatus`, so once `HTTP_STATUS_ENUM_VALUES` is right, the shorthand
 * table can't independently drift from it; only the transform itself could
 * ever go wrong, and that's covered by the drift test too.
 */

/**
 * Every built-in HTTP exception subclass `@nestjs/common` exports, mapped to
 * the status code it always throws. Deliberately excludes the generic
 * `HttpException` base class itself — its status is whatever its second
 * constructor argument says, which `resolve-status.ts` handles as its own
 * case (PLAN §4.1a/§4.3) — and `IntrinsicException`, an internal marker base
 * class rather than a concrete throwable with a fixed status.
 */
export const BUILTIN_HTTP_EXCEPTIONS: Readonly<Record<string, number>> = {
  BadGatewayException: 502,
  BadRequestException: 400,
  ConflictException: 409,
  ForbiddenException: 403,
  GatewayTimeoutException: 504,
  GoneException: 410,
  HttpVersionNotSupportedException: 505,
  ImATeapotException: 418,
  InternalServerErrorException: 500,
  MethodNotAllowedException: 405,
  MisdirectedException: 421,
  NotAcceptableException: 406,
  NotFoundException: 404,
  NotImplementedException: 501,
  PayloadTooLargeException: 413,
  PreconditionFailedException: 412,
  RequestTimeoutException: 408,
  ServiceUnavailableException: 503,
  UnauthorizedException: 401,
  UnprocessableEntityException: 422,
  UnsupportedMediaTypeException: 415,
};

/**
 * `HttpStatus` enum member name → numeric value, mirroring
 * `@nestjs/common`'s `HttpStatus` enum in full (all name-keyed members; the
 * enum's reverse numeric-string keys aren't included here). Used as a
 * fallback when `checker.getConstantValue` can't fold an `HttpStatus.X`
 * member access (`status-value.ts`), and as the source `SHORTHAND_RESPONSE_
 * DECORATORS` below is mechanically derived from.
 */
export const HTTP_STATUS_ENUM_VALUES: Readonly<Record<string, number>> = {
  CONTINUE: 100,
  SWITCHING_PROTOCOLS: 101,
  PROCESSING: 102,
  EARLYHINTS: 103,
  OK: 200,
  CREATED: 201,
  ACCEPTED: 202,
  NON_AUTHORITATIVE_INFORMATION: 203,
  NO_CONTENT: 204,
  RESET_CONTENT: 205,
  PARTIAL_CONTENT: 206,
  MULTI_STATUS: 207,
  ALREADY_REPORTED: 208,
  CONTENT_DIFFERENT: 210,
  AMBIGUOUS: 300,
  MOVED_PERMANENTLY: 301,
  FOUND: 302,
  SEE_OTHER: 303,
  NOT_MODIFIED: 304,
  TEMPORARY_REDIRECT: 307,
  PERMANENT_REDIRECT: 308,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  PAYMENT_REQUIRED: 402,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  NOT_ACCEPTABLE: 406,
  PROXY_AUTHENTICATION_REQUIRED: 407,
  REQUEST_TIMEOUT: 408,
  CONFLICT: 409,
  GONE: 410,
  LENGTH_REQUIRED: 411,
  PRECONDITION_FAILED: 412,
  PAYLOAD_TOO_LARGE: 413,
  URI_TOO_LONG: 414,
  UNSUPPORTED_MEDIA_TYPE: 415,
  REQUESTED_RANGE_NOT_SATISFIABLE: 416,
  EXPECTATION_FAILED: 417,
  I_AM_A_TEAPOT: 418,
  MISDIRECTED: 421,
  UNPROCESSABLE_ENTITY: 422,
  LOCKED: 423,
  FAILED_DEPENDENCY: 424,
  PRECONDITION_REQUIRED: 428,
  TOO_MANY_REQUESTS: 429,
  UNRECOVERABLE_ERROR: 456,
  INTERNAL_SERVER_ERROR: 500,
  NOT_IMPLEMENTED: 501,
  BAD_GATEWAY: 502,
  SERVICE_UNAVAILABLE: 503,
  GATEWAY_TIMEOUT: 504,
  HTTP_VERSION_NOT_SUPPORTED: 505,
  INSUFFICIENT_STORAGE: 507,
  LOOP_DETECTED: 508,
};

/**
 * The exact name-generation transform `@nestjs/swagger` uses to derive its
 * shorthand `@Api*Response` decorators from `HttpStatus` (copied from
 * `@nestjs/swagger`'s `dist/decorators/api-response.decorator.js`, verified
 * in `test/unit/nest-exceptions-drift.test.ts`):
 * `HttpStatus` member name, `_`-split, each token title-cased
 * (`I_AM_A_TEAPOT` -> `I` + `Am` + `A` + `Teapot` -> `IAmATeapot`), joined,
 * wrapped in `Api` + ... + `Response`.
 */
export function shorthandResponseDecoratorName(httpStatusMemberName: string): string {
  const titleCased = httpStatusMemberName
    .split('_')
    .map((token) => `${token[0]}${token.slice(1).toLowerCase()}`)
    .join('');
  return `Api${titleCased}Response`;
}

/**
 * `@nestjs/swagger` shorthand `@Api*Response` decorator name → the status
 * code it documents, mechanically derived from `HTTP_STATUS_ENUM_VALUES` via
 * `shorthandResponseDecoratorName` — this is exactly how `@nestjs/swagger`
 * itself generates these decorators, so this table cannot drift out of sync
 * with `HTTP_STATUS_ENUM_VALUES`; only that one table needs the drift test.
 * `ApiResponse` (generic) and `ApiDefaultResponse` (wildcard) are handled
 * separately in `documented.ts` since neither maps to a single fixed status.
 */
export const SHORTHAND_RESPONSE_DECORATORS: Readonly<Record<string, number>> = Object.fromEntries(
  Object.entries(HTTP_STATUS_ENUM_VALUES).map(([key, status]) => [
    shorthandResponseDecoratorName(key),
    status,
  ]),
);
