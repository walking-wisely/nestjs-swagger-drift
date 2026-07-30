/**
 * Resolves an expression to a concrete numeric HTTP status where statically
 * possible — shared between `resolve-status.ts` (§4.2 step 3, `super(msg,
 * HttpStatus.CONFLICT)` / `new HttpException(msg, HttpStatus.NOT_FOUND)`) and
 * `documented.ts` (§4.3, `@ApiResponse({ status: HttpStatus.NOT_FOUND })`).
 *
 * Two independent strategies, either one sufficient:
 *
 * 1. `checker.getConstantValue` — the real, general mechanism for folding an
 *    enum member access to its literal value. Works whenever the checker can
 *    prove the enum member has a literal initializer, `const enum` or not.
 * 2. A name-based fallback against `HTTP_STATUS_ENUM_VALUES`, gated on the
 *    member's *object* provenance-checking as `@nestjs/common` (not
 *    `'mismatch'`). This exists for the same reason `decorators.ts` accepts
 *    `'unverified'` provenance by name: this project's own test fixtures
 *    stub `HttpStatus` as an ambient `declare module` enum, and depending on
 *    exactly how such a stub is shaped the checker does not always treat it
 *    as constant-foldable. Falling back to name matching only when
 *    provenance isn't a confirmed *mismatch* keeps the "never silently
 *    misattribute a locally-declared same-named enum" guarantee intact.
 *
 * Anything else (a non-literal, a `let`, a function call, an enum the
 * checker can't fold and whose object doesn't resolve to `@nestjs/common`)
 * returns `undefined` — callers must treat that as unresolvable, not guess.
 */

import * as ts from 'typescript';
import { checkProvenance } from './provenance.js';
import { HTTP_STATUS_ENUM_VALUES } from './nest-exceptions.js';

const NEST_COMMON_MODULE = '@nestjs/common';

export function resolveStatusExpression(
  expr: ts.Expression,
  checker: ts.TypeChecker,
): number | undefined {
  if (ts.isNumericLiteral(expr)) return Number(expr.text);

  if (ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr)) {
    try {
      const value = checker.getConstantValue(expr);
      if (typeof value === 'number') return value;
    } catch {
      // fall through to the name-based fallback below
    }
  }

  try {
    const type = checker.getTypeAtLocation(expr);
    if (type.isNumberLiteral()) return type.value;
  } catch {
    // fall through
  }

  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.name)) {
    const { provenance } = checkProvenance(expr.expression, checker, NEST_COMMON_MODULE);
    if (provenance !== 'mismatch') {
      const known = HTTP_STATUS_ENUM_VALUES[expr.name.text];
      if (known !== undefined) return known;
    }
  }

  return undefined;
}
