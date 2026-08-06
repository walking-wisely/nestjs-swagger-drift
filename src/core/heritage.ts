/**
 * Resolves a class declaration's direct `extends` base class, when it's a
 * simple `class X extends Y {}` reference the checker can pin to another
 * class declaration in this program (possibly in a different file).
 *
 * Shared by `documented.ts` (PLAN §4.3 review S1: a class-level
 * `@ApiResponse`-family decorator on an ANCESTOR class documents every
 * descendant's handlers too — `@nestjs/swagger` reads it via
 * `Reflect.getMetadata`, which walks the prototype chain, the same reason
 * `handlers.ts` documents inherited *route* handlers as a known gap for
 * PLAN §6) and, from Phase 3 on, `resolve-status.ts`'s extends-chain
 * strategy (PLAN §4.2 step 1) — both need the identical "one level up the
 * `extends` clause" primitive; only what they DO with the resolved base
 * class declaration differs.
 */

import * as ts from 'typescript';

/**
 * Follows an alias symbol (an imported binding) through to the symbol it
 * actually refers to. Exported (`guard-narrowing.ts` needs the identical
 * step for a decorator factory's imported binding, not just a class
 * reference — extracted rather than duplicated, same reasoning as
 * `resolveClassDeclaration` below) — returns `symbol` unchanged if it isn't
 * an alias, or if the checker can't advance past it (an unresolved import,
 * same "can't fully pin down" case `decorators.ts`'s module doc discusses).
 */
export function resolveAliasedSymbol(symbol: ts.Symbol, checker: ts.TypeChecker): ts.Symbol {
  if ((symbol.flags & ts.SymbolFlags.Alias) === 0) return symbol;
  try {
    const aliased = checker.getAliasedSymbol(symbol);
    if (aliased !== symbol && (aliased.getDeclarations()?.length ?? 0) > 0) return aliased;
  } catch {
    // falls through: stays `symbol`
  }
  return symbol;
}

/**
 * Resolves an arbitrary expression (an `extends` clause's expression, or a
 * `new X(...)` callee) to the class declaration it statically refers to,
 * following import aliases the same way `provenance.ts`'s `checkProvenance`
 * does. Factored out of `getBaseClassDeclaration` in Phase 3 so
 * `resolve-status.ts`'s custom-exception strategy (PLAN §4.2 step 1) can
 * resolve the class a `new SomeCustomException(...)` expression instantiates
 * with the identical alias-resolution logic, rather than a second copy of it.
 */
export function resolveClassDeclaration(
  expr: ts.Expression,
  checker: ts.TypeChecker,
): ts.ClassLikeDeclaration | undefined {
  let symbol: ts.Symbol | undefined;
  try {
    symbol = checker.getSymbolAtLocation(expr);
  } catch {
    symbol = undefined;
  }
  if (!symbol) return undefined;

  const resolved = resolveAliasedSymbol(symbol, checker);
  return resolved.getDeclarations()?.find(ts.isClassLike);
}

export function getBaseClassDeclaration(
  classNode: ts.ClassLikeDeclaration,
  checker: ts.TypeChecker,
): ts.ClassLikeDeclaration | undefined {
  for (const clause of classNode.heritageClauses ?? []) {
    if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
    const expr = clause.types[0]?.expression;
    if (!expr) return undefined;
    return resolveClassDeclaration(expr, checker);
  }
  return undefined;
}
