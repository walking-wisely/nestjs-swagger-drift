/**
 * Drift test for `src/core/nest-exceptions.ts`'s hand-maintained-turned-
 * mechanically-verified tables, run against the REAL `@nestjs/common`/
 * `@nestjs/swagger` packages — installed under npm aliases
 * (`nest-common-snapshot`/`nest-swagger-snapshot`, see `.npmrc` and
 * `package.json`'s `devDependencies`) specifically so `node_modules/@nestjs`
 * never gets created and the `test/fixtures/unresolved-module*` fixtures'
 * "this tsconfig genuinely cannot resolve `@nestjs/common`" premise stays
 * intact. See `nest-exceptions.ts`'s module doc for the full rationale and
 * `.npmrc`'s comment for why `legacy-peer-deps=true` is load-bearing here.
 *
 * Two different verification strategies, because the two aliased packages
 * behave differently under Node's module resolution:
 *
 * - `nest-common-snapshot` (`@nestjs/common`) has no `exports` map, so its
 *   `exceptions` and `enums` subpaths can be `require()`d directly and
 *   *executed* — real classes, real `getStatus()` calls, real enum object.
 * - `nest-swagger-snapshot` (`@nestjs/swagger`)'s `dist/decorators/*` is
 *   NOT executable in this setup: its own internals do a bare
 *   `require('@nestjs/common')`, which is unresolvable here by design (see
 *   above) — actually running it would need a Node module-resolution
 *   redirect hook plus `rxjs`/`lodash` as further devDependencies, which is
 *   a lot of machinery whose only job is verifying a string-transform. So
 *   `SHORTHAND_RESPONSE_DECORATORS` is verified by statically reading the
 *   compiled decorator names out of `dist/decorators/api-response.decorator.js`
 *   (`exports.ApiXResponse = ...`) and checking each real name is exactly
 *   what our transform (copied from that same file's `statusList` builder —
 *   see `nest-exceptions.ts`) produces from `HTTP_STATUS_ENUM_VALUES`
 *   (itself runtime-verified below). This is weaker than executing the
 *   decorator (it can't catch the transform assigning the wrong *value*,
 *   only the wrong *name*), but combined with the `HttpStatus`-enum
 *   drift check, a wrong value would require both packages' independently
 *   published enums to have silently disagreed on a status code, which is
 *   its own more fundamental problem.
 */

import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  BUILTIN_HTTP_EXCEPTIONS,
  HTTP_STATUS_ENUM_VALUES,
  SHORTHAND_RESPONSE_DECORATORS,
  shorthandResponseDecoratorName,
  UNEXPORTED_SHORTHAND_STATUSES,
} from '../../src/core/nest-exceptions.js';

const require = createRequire(import.meta.url);

interface ExceptionCtor {
  new (): { getStatus(): number };
}

describe('BUILTIN_HTTP_EXCEPTIONS against the real @nestjs/common', () => {
  it('matches every built-in *Exception subclass exactly', () => {
    const real = require('nest-common-snapshot/exceptions') as Record<string, unknown>;
    const actual: Record<string, number> = {};
    for (const [name, value] of Object.entries(real)) {
      if (!/Exception$/.test(name)) continue;
      // `HttpException` (the generic base) and `IntrinsicException` (an
      // internal marker base class, not a concrete throwable with a fixed
      // status) are deliberately excluded from our table — see
      // `nest-exceptions.ts`'s doc comment.
      if (name === 'HttpException' || name === 'IntrinsicException') continue;
      const Ctor = value as ExceptionCtor;
      actual[name] = new Ctor().getStatus();
    }
    expect(BUILTIN_HTTP_EXCEPTIONS).toEqual(actual);
  });
});

describe('HTTP_STATUS_ENUM_VALUES against the real @nestjs/common HttpStatus', () => {
  it('matches every name-keyed member exactly', () => {
    const { HttpStatus } = require('nest-common-snapshot/enums') as {
      HttpStatus: Record<string, number | string>;
    };
    const actual: Record<string, number> = {};
    for (const key of Object.keys(HttpStatus)) {
      const value = HttpStatus[key];
      // `HttpStatus` is a numeric TS enum, so `Object.keys` also yields the
      // reverse numeric-string keys (`"404"` -> `"NOT_FOUND"`); only the
      // name-keyed entries belong in our name -> number mirror.
      if (typeof value === 'number') actual[key] = value;
    }
    expect(HTTP_STATUS_ENUM_VALUES).toEqual(actual);
  });
});

describe('SHORTHAND_RESPONSE_DECORATORS against the real @nestjs/swagger export names', () => {
  it('is mechanically derived from HTTP_STATUS_ENUM_VALUES with the exact transform @nestjs/swagger uses', () => {
    const derived: Record<string, number> = {};
    for (const [key, status] of Object.entries(HTTP_STATUS_ENUM_VALUES)) {
      derived[shorthandResponseDecoratorName(key)] = status;
    }
    expect(SHORTHAND_RESPONSE_DECORATORS).toEqual(derived);
  });

  it('produces the exact real decorator name for every shorthand @nestjs/swagger actually exports', () => {
    const swaggerPackageJson = require.resolve('nest-swagger-snapshot/package.json');
    const decoratorFile = join(
      dirname(swaggerPackageJson),
      'dist/decorators/api-response.decorator.js',
    );
    const source = readFileSync(decoratorFile, 'utf8');
    const realNames = new Set(
      [...source.matchAll(/exports\.(Api\w*Response) = /g)]
        .map((m) => m[1])
        .filter((name): name is string => name !== undefined),
    );
    // `ApiResponse` (generic) and `ApiDefaultResponse` (wildcard) aren't
    // status-keyed shorthands — `documented.ts` handles both separately.
    realNames.delete('ApiResponse');
    realNames.delete('ApiDefaultResponse');
    expect(realNames.size).toBeGreaterThan(40); // sanity: the static parse actually found the real list

    for (const name of realNames) {
      expect(SHORTHAND_RESPONSE_DECORATORS).toHaveProperty(name);
    }
  });

  it('UNEXPORTED_SHORTHAND_STATUSES is exactly the set of statuses the real package does NOT export a shorthand for', () => {
    // The REVERSE direction of the previous test — that one only asserts
    // "every real export is in our table" (a superset is fine there, see
    // `SHORTHAND_RESPONSE_DECORATORS`'s doc comment), so it could never have
    // caught `UNEXPORTED_SHORTHAND_STATUSES` going stale in EITHER
    // direction: a status added here that the real package actually DOES
    // export (Tier 1 autofix wrongly forced to the generic `ApiResponse`
    // fallback for no reason) or a status @nestjs/swagger stops exporting
    // that ISN'T listed here (Tier 1 autofix generates a call to a name that
    // no longer exists — the exact class of bug this constant exists to
    // prevent, found via `test/integration/fix-decorator-runtime.test.ts`
    // actually executing the generated calls against the real package).
    const swaggerPackageJson = require.resolve('nest-swagger-snapshot/package.json');
    const decoratorFile = join(dirname(swaggerPackageJson), 'dist/decorators/api-response.decorator.js');
    const source = readFileSync(decoratorFile, 'utf8');
    const realNames = new Set(
      [...source.matchAll(/exports\.(Api\w*Response) = /g)]
        .map((m) => m[1])
        .filter((name): name is string => name !== undefined),
    );
    realNames.delete('ApiResponse');
    realNames.delete('ApiDefaultResponse');

    for (const [name, status] of Object.entries(SHORTHAND_RESPONSE_DECORATORS)) {
      const reallyExported = realNames.has(name);
      const claimedUnexported = UNEXPORTED_SHORTHAND_STATUSES.has(status);
      expect(
        reallyExported,
        `status ${status} (${name}): really exported=${reallyExported}, ` +
          `claimed unexported=${claimedUnexported} — these must disagree`,
      ).toBe(!claimedUnexported);
    }
  });
});
