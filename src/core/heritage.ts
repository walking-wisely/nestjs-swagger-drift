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

export function getBaseClassDeclaration(
  classNode: ts.ClassLikeDeclaration,
  checker: ts.TypeChecker,
): ts.ClassLikeDeclaration | undefined {
  for (const clause of classNode.heritageClauses ?? []) {
    if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
    const expr = clause.types[0]?.expression;
    if (!expr) return undefined;

    let symbol: ts.Symbol | undefined;
    try {
      symbol = checker.getSymbolAtLocation(expr);
    } catch {
      symbol = undefined;
    }
    if (!symbol) return undefined;

    let resolved = symbol;
    if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
      try {
        const aliased = checker.getAliasedSymbol(symbol);
        if (aliased !== symbol && (aliased.getDeclarations()?.length ?? 0) > 0) {
          resolved = aliased;
        }
      } catch {
        // `resolved` stays `symbol`.
      }
    }

    return resolved.getDeclarations()?.find(ts.isClassLike);
  }
  return undefined;
}
