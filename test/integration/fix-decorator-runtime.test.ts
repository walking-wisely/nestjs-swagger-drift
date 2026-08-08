/**
 * Runs Tier 1 autofix's generated decorator CALLS against the REAL
 * `@nestjs/swagger` package (via `test/helpers/real-swagger-decorators.ts`)
 * — the gap `test/integration/fix.test.ts` structurally cannot close, since
 * it only asserts on the GENERATED TEXT (`applyFixesToFile`'s `after`
 * string). Text assertions can't see whether the decorator call that text
 * represents actually RUNS without throwing, or — the sharper question,
 * found missing during manual validation against a real repo (Ever Gauzy,
 * PLAN §10.0) — whether MULTIPLE decorators `apply.ts` stacks onto the same
 * method (the common case: a handler missing several statuses) correctly
 * ACCUMULATE metadata instead of one clobbering another. Both are runtime
 * facts about a stateful `Reflect.defineMetadata` merge inside
 * `@nestjs/swagger`'s own implementation — invisible to `tsc --noEmit`
 * (never calls the decorator factory) and invisible to a plain unit test
 * against an isolated dummy class per call (never gives the merge anything
 * to merge WITH). See this file's git history / PLAN.md for the fuller
 * writeup of why a naive "call every decorator once, in isolation" smoke
 * test would have passed even if stacking were broken.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HTTP_STATUS_ENUM_VALUES, UNEXPORTED_SHORTHAND_STATUSES } from '../../src/core/index.js';
import {
  escapeSingleQuoted,
  shorthandDecoratorForStatus,
  statusDescription,
} from '../../src/cli/fix/status-text.js';
import {
  loadRealSwaggerResponseDecorators,
  type RealSwaggerResponseDecorators,
} from '../helpers/real-swagger-decorators.js';

let real: RealSwaggerResponseDecorators;

beforeAll(() => {
  real = loadRealSwaggerResponseDecorators();
});

afterAll(() => {
  real.restore();
});

/** A fresh class with one method, so each test starts from a clean `Reflect` metadata slate. */
function dummyMethod(): { target: object; propertyKey: string; descriptor: PropertyDescriptor } {
  class Dummy {
    method(): void {
      /* no-op */
    }
  }
  const descriptor = Object.getOwnPropertyDescriptor(Dummy.prototype, 'method');
  if (!descriptor) throw new Error('unreachable: method was just declared');
  return { target: Dummy.prototype, propertyKey: 'method', descriptor };
}

/** Applies `decorator` the same way TypeScript's compiled `__decorate` helper does: call, then re-`defineProperty` if it returned a new descriptor. */
function apply(
  decorator: ReturnType<RealSwaggerResponseDecorators['decorators'][string]>,
  target: object,
  propertyKey: string,
  descriptor: PropertyDescriptor,
): void {
  const result = decorator(target, propertyKey, descriptor);
  if (result) Object.defineProperty(target, propertyKey, result);
}

function accumulatedResponses(target: object, propertyKey: string): Record<string, unknown> {
  const descriptor = Object.getOwnPropertyDescriptor(target, propertyKey);
  const fn = (descriptor?.value ?? {}) as object;
  return (Reflect.getMetadata(real.apiResponseMetadataKey, fn) ?? {}) as Record<string, unknown>;
}

/** Bracket-notation lookup by name, throwing if the real package doesn't export it — every call site below wants a hard failure, not `undefined`, on a missing export. */
function getDecorator(name: string): RealSwaggerResponseDecorators['decorators'][string] {
  const factory = real.decorators[name];
  if (!factory) throw new Error(`@nestjs/swagger has no export named ${name}`);
  return factory;
}

describe('every shorthand decorator shorthandDecoratorForStatus can pick executes cleanly', () => {
  it('exists on the real package and applying it records metadata under the right status key', () => {
    // Deliberately driven by `shorthandDecoratorForStatus` — the function
    // Tier 1 autofix ACTUALLY calls to pick a name to generate — not the
    // raw `SHORTHAND_RESPONSE_DECORATORS` recognition table, which still
    // contains 7 names `@nestjs/swagger` doesn't export (see
    // `UNEXPORTED_SHORTHAND_STATUSES`'s doc comment). Iterating the raw
    // table here is exactly what let `ApiMultiStatusResponse` (207) slip
    // through undetected the first time this test was written.
    let checked = 0;
    for (const status of Object.values(HTTP_STATUS_ENUM_VALUES)) {
      const name = shorthandDecoratorForStatus(status);
      if (name === undefined) continue; // no shorthand for this status -- generic ApiResponse, covered below
      checked++;

      const factory = getDecorator(name);

      const { target, propertyKey, descriptor } = dummyMethod();
      const description = escapeSingleQuoted(statusDescription(status));
      expect(() => apply(factory({ description }), target, propertyKey, descriptor)).not.toThrow();

      const responses = accumulatedResponses(target, propertyKey);
      expect(responses).toHaveProperty(String(status));
    }
    // Sanity: the skip-if-undefined branch above must not have quietly
    // skipped everything (e.g. if `shorthandDecoratorForStatus` regressed
    // to always returning `undefined`).
    expect(checked).toBeGreaterThan(40);
  });

  it('never picks one of the 7 statuses @nestjs/swagger does not actually export a shorthand for', () => {
    for (const status of UNEXPORTED_SHORTHAND_STATUSES) {
      expect(shorthandDecoratorForStatus(status)).toBeUndefined();
    }
  });
});

describe('the generic ApiResponse fallback (a status with no shorthand)', () => {
  it('executes cleanly and records metadata under its numeric status', () => {
    const { target, propertyKey, descriptor } = dummyMethod();
    // Mirrors apply.ts's decoratorArgumentText for the non-shorthand branch exactly: `{ status, description }`.
    expect(() =>
      apply(getDecorator('ApiResponse')({ status: 431, description: 'Status 431' }), target, propertyKey, descriptor),
    ).not.toThrow();
    expect(accumulatedResponses(target, propertyKey)).toHaveProperty('431');
  });
});

describe('stacking multiple decorators on ONE method (apply.ts inserts one per missing status)', () => {
  it('accumulates every status instead of the last insertDecorator(0, ...) call clobbering earlier ones', () => {
    const { target, propertyKey, descriptor } = dummyMethod();
    // `apply.ts` prepends via `insertDecorator(0, ...)` once per entry, in
    // descending-position-then-insertion order; the REAL runtime application
    // order TypeScript compiles that to is bottom-to-top of the final
    // decorator list — exercised here as three separate `apply()` calls
    // against the SAME method, exactly what the real merge has to survive.
    apply(getDecorator('ApiBadRequestResponse')({ description: 'Bad Request' }), target, propertyKey, descriptor);
    apply(getDecorator('ApiConflictResponse')({ description: 'Conflict' }), target, propertyKey, descriptor);
    apply(getDecorator('ApiOkResponse')({ description: 'Ok' }), target, propertyKey, descriptor);

    const responses = accumulatedResponses(target, propertyKey);
    expect(Object.keys(responses).sort()).toEqual(['200', '400', '409']);
  });
});

describe('inserting alongside a PRE-EXISTING hand-written decorator (the common real-world case)', () => {
  it('leaves the hand-written entry intact and adds the new one alongside it', () => {
    const { target, propertyKey, descriptor } = dummyMethod();
    // "Hand-written, pre-dating autofix" — applied first, same as it would
    // already be in the source file before `--fix` ever touches it.
    apply(
      getDecorator('ApiCreatedResponse')({ description: 'The record was created' }),
      target,
      propertyKey,
      descriptor,
    );
    // What `apply.ts` inserts on top.
    apply(getDecorator('ApiConflictResponse')({ description: 'Conflict' }), target, propertyKey, descriptor);

    const responses = accumulatedResponses(target, propertyKey) as Record<string, { description?: string }>;
    expect(responses['201']?.description).toBe('The record was created');
    expect(responses['409']?.description).toBe('Conflict');
  });
});
