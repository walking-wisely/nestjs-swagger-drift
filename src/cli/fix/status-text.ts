/**
 * Status code -> decorator/prose text for Tier 1 autofix (PLAN §10.2).
 *
 * `HTTP_STATUS_ENUM_VALUES`/`SHORTHAND_RESPONSE_DECORATORS` (`core/
 * nest-exceptions.ts`) are the source of truth `documented.ts` uses to
 * RECOGNIZE these decorators; this module inverts them to pick which one to
 * INSERT. That's a stronger requirement than recognition: inserting a call
 * to a decorator name `@nestjs/swagger` doesn't actually export throws a
 * real `TypeError` at runtime the moment the fixed file executes (found
 * running the generated calls against the real package —
 * `test/integration/fix-decorator-runtime.test.ts`), where RECOGNIZING an
 * unexported name is merely inert (nobody could have legally written it).
 * `shorthandDecoratorForStatus` below excludes `UNEXPORTED_SHORTHAND_
 * STATUSES` for exactly this reason — see that constant's doc comment in
 * `nest-exceptions.ts` for the full list and why it's a real, if narrow,
 * drift risk rather than a permanent hand-maintained assumption.
 */

import {
  HTTP_STATUS_ENUM_VALUES,
  SHORTHAND_RESPONSE_DECORATORS,
  UNEXPORTED_SHORTHAND_STATUSES,
} from '../../core/index.js';

/**
 * `HttpStatus` numeric value -> shorthand decorator name, e.g. `404 ->
 * 'ApiNotFoundResponse'`. Built once at module load; every value in
 * `HTTP_STATUS_ENUM_VALUES` is unique (verified by
 * `nest-exceptions-drift.test.ts`), so this inversion is unambiguous.
 */
const STATUS_TO_SHORTHAND_DECORATOR: ReadonlyMap<number, string> = new Map(
  Object.entries(SHORTHAND_RESPONSE_DECORATORS).map(([name, status]) => [status, name]),
);

/** `HttpStatus` numeric value -> its enum member name, e.g. `404 -> 'NOT_FOUND'`. */
const STATUS_TO_ENUM_NAME: ReadonlyMap<number, string> = new Map(
  Object.entries(HTTP_STATUS_ENUM_VALUES).map(([name, status]) => [status, name]),
);

/**
 * The shorthand `@Api*Response` decorator name for `status`, or `undefined`
 * if `status` isn't one of `HttpStatus`'s named members (e.g. a custom
 * exception's status that happens not to line up with any `HttpStatus`
 * value) OR — a status `@nestjs/swagger` itself doesn't provide a shorthand
 * for despite `HttpStatus` having it — is in `UNEXPORTED_SHORTHAND_
 * STATUSES`. Either way the caller falls back to generic
 * `@ApiResponse({ status })`.
 */
export function shorthandDecoratorForStatus(status: number): string | undefined {
  if (UNEXPORTED_SHORTHAND_STATUSES.has(status)) return undefined;
  return STATUS_TO_SHORTHAND_DECORATOR.get(status);
}

/**
 * Human-readable description text for `status` (PLAN §10.2: "derived from
 * the same exception-class -> status table the engine already uses for
 * detection ... No attempt at richer prose"), e.g. `404 -> 'Not Found'`,
 * `409 -> 'Conflict'`. Falls back to `'Status <n>'` for a status with no
 * `HttpStatus` member (still a valid, if plain, `description` string).
 */
export function statusDescription(status: number): string {
  const enumName = STATUS_TO_ENUM_NAME.get(status);
  if (enumName === undefined) return `Status ${status}`;
  return enumName
    .split('_')
    .map((word) => word.charAt(0) + word.slice(1).toLowerCase())
    .join(' ');
}

/** Escapes a single-quoted string literal's content, defensive against a future description containing `'`. */
export function escapeSingleQuoted(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
