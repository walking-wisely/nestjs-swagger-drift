/**
 * Loads the REAL, executable `@nestjs/swagger` `@Api*Response`/`ApiResponse`
 * decorator functions — not just their type signatures (which
 * `test/fixtures/**`'s ambient `.d.ts` stubs already cover) and not just
 * their compiled NAMES (which `test/unit/nest-exceptions-drift.test.ts`
 * already statically parses out of `dist/decorators/api-response.decorator.js`
 * without running it — see that file's module doc for why it stopped short
 * of execution). This module is what makes execution actually possible for
 * `test/integration/fix-decorator-runtime.test.ts`: applying a decorator
 * Tier 1 autofix (`src/cli/fix/apply.ts`) generates to a REAL method and
 * reading back the REAL `Reflect` metadata it wrote — the class of bug
 * `tsc --noEmit` cannot see (it never calls a decorator factory, only
 * type-checks the call), and that a purely-typed ambient stub cannot see
 * either (a stub's decorator factory is a no-op signature, not the real
 * merge-with-whatever-was-already-there logic).
 *
 * ## Why this needs a resolution redirect at all
 *
 * `@nestjs/swagger` and `@nestjs/common` are installed here under npm
 * ALIASES (`nest-swagger-snapshot`/`nest-common-snapshot`), specifically so
 * `node_modules/@nestjs/common` never exists under its real name — see
 * `src/core/nest-exceptions.ts`'s module doc for the full reason (in short:
 * `test/fixtures/unresolved-module*` fixtures depend on `@nestjs/common` staying
 * genuinely unresolvable from a fixture's tsconfig, which breaks the moment
 * a real `node_modules/@nestjs/common` exists anywhere Node's/TS's module
 * resolution would walk up into from this repo's root). But
 * `nest-swagger-snapshot`'s own compiled JS does `require('@nestjs/common')`
 * internally (it has no idea it's been aliased) — so loading it for real
 * needs those internal requires satisfied WITHOUT ever creating that
 * top-level `node_modules/@nestjs/common` directory.
 *
 * The fix: a temporary, narrowly-scoped `Module._resolveFilename` patch that
 * only intercepts a `@nestjs/common` (or `@nestjs/common/<subpath>`) request
 * whose REQUESTING file lives inside `nest-swagger-snapshot`'s own
 * `node_modules` folder, and redirects it to `nest-common-snapshot`'s real
 * install location. Every other module's requires (including this test
 * suite's own, and every fixture's) are untouched — the redirect is a no-op
 * for any parent module outside that one package. Reversible via
 * `restore()`, so a test that installs it can clean up in `afterAll`.
 *
 * `nest-swagger-snapshot`'s package.json restricts its public `exports` map
 * to `.` (the full `dist/index.js`, which eagerly pulls in `@nestjs/core`,
 * `swagger-ui-dist`, and friends — dependencies this repo has no reason to
 * carry) and `./plugin`. `dist/decorators/api-response.decorator.js` is
 * loaded by its ABSOLUTE FILESYSTEM PATH instead of a package specifier —
 * Node's `exports` restriction only gates package-specifier resolution, not
 * a literal path, so this is not a workaround of that restriction so much
 * as simply not going through it. That file's own relative requires
 * (`../constants`, `./helpers`, `../plugin/plugin-constants`) resolve
 * normally on disk either way. Its remaining bare requires are `@nestjs/
 * common` (redirected, see above) and `lodash` (a plain, undisguised
 * `devDependency` here — no reason to hide it) — `@nestjs/common`'s own
 * index additionally needs `rxjs` transitively (`serializer/index.js`),
 * hence `rxjs` is a `devDependency` here too, used ONLY by this test path.
 */

import 'reflect-metadata';
import { createRequire } from 'node:module';
import Module from 'node:module';
import { dirname, join, sep } from 'node:path';

const require = createRequire(import.meta.url);

/** A decorator factory shaped like every `@Api*Response`/`ApiResponse` export: `(options) => MethodDecorator`. */
export type ResponseDecoratorFactory = (options: {
  status?: number;
  description?: string;
}) => (target: object, propertyKey: string, descriptor: PropertyDescriptor) => PropertyDescriptor | void;

export interface RealSwaggerResponseDecorators {
  /** Every named export of `dist/decorators/api-response.decorator.js` — all shorthand names plus `ApiResponse`. */
  decorators: Record<string, ResponseDecoratorFactory>;
  /** The real `Reflect` metadata key `@nestjs/swagger` stores accumulated per-status responses under. */
  apiResponseMetadataKey: string;
  /** Undoes the `Module._resolveFilename` patch. Call in `afterAll`. */
  restore: () => void;
}

/**
 * Installs the redirect, loads the real decorator module + its metadata key
 * constant, and returns both plus a `restore()` to undo the patch. Safe to
 * call once per test file (`beforeAll`); the patch only affects requires
 * whose parent file is inside `nest-swagger-snapshot`, so it's inert for
 * everything else even if left installed longer than intended.
 */
/**
 * `Module._resolveFilename` is Node's real, load-bearing CJS resolution
 * hook (every `require()` in the process goes through it), but it's an
 * internal API `@types/node` doesn't declare — hence the one cast, isolated
 * to this single narrow type rather than scattered across the function.
 */
type ResolveFilename = (
  this: unknown,
  request: string,
  parent: { filename?: string } | undefined,
  isMain: boolean,
  options: unknown,
) => string;
const ModuleInternals = Module as unknown as { _resolveFilename: ResolveFilename };

export function loadRealSwaggerResponseDecorators(): RealSwaggerResponseDecorators {
  const commonRoot = dirname(require.resolve('nest-common-snapshot/package.json'));
  const swaggerRoot = dirname(require.resolve('nest-swagger-snapshot/package.json'));

  const originalResolveFilename = ModuleInternals._resolveFilename;
  ModuleInternals._resolveFilename = function (request, parent, isMain, options) {
    if (
      (request === '@nestjs/common' || request.startsWith('@nestjs/common/')) &&
      parent?.filename?.startsWith(swaggerRoot + sep)
    ) {
      const redirected =
        request === '@nestjs/common'
          ? commonRoot
          : join(commonRoot, request.slice('@nestjs/common/'.length));
      return originalResolveFilename.call(this, redirected, parent, isMain, options);
    }
    return originalResolveFilename.call(this, request, parent, isMain, options);
  };

  const decorators = require(join(swaggerRoot, 'dist/decorators/api-response.decorator.js')) as Record<
    string,
    ResponseDecoratorFactory
  >;
  const { DECORATORS } = require(join(swaggerRoot, 'dist/constants.js')) as {
    DECORATORS: { API_RESPONSE: string };
  };

  return {
    decorators,
    apiResponseMetadataKey: DECORATORS.API_RESPONSE,
    restore: () => {
      ModuleInternals._resolveFilename = originalResolveFilename;
    },
  };
}
