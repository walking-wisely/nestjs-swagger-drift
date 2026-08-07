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
 * Finds a `ts.ClassLikeDeclaration` behind `type`, for the mixin fallback
 * below: first `type`'s own symbol directly (covers a `typeof SomeClass`-
 * shaped type — e.g. a non-generic mixin function's parameter, or its
 * return type, typed as a concrete class rather than a generic type
 * parameter), then, if that comes up empty, every call/construct
 * signature's return type (covers `SomeMixin(Base)` itself — the CALL's own
 * type is the returned class's constructor type, e.g. `typeof Mixed`, whose
 * construct signature's return type is `Mixed`'s instance type). Both call
 * and construct signatures are checked since a mixin factory can be typed
 * either way (a plain function returning a class value has call signatures
 * on its OWN type only when the class itself is invoked as a function,
 * which never applies to a class — so in practice it's the construct
 * signature that matters here; call signatures are checked too since the
 * checker doesn't guarantee which bucket a given callable type's signatures
 * land in).
 */
function resolveClassDeclarationFromType(type: ts.Type): ts.ClassLikeDeclaration | undefined {
  const direct = type.getSymbol()?.getDeclarations()?.find(ts.isClassLike);
  if (direct) return direct;

  for (const signature of [...type.getConstructSignatures(), ...type.getCallSignatures()]) {
    const returnType = signature.getReturnType();
    const decl = returnType.getSymbol()?.getDeclarations()?.find(ts.isClassLike);
    if (decl) return decl;
  }
  return undefined;
}

/**
 * Resolves an arbitrary expression (an `extends` clause's expression, a
 * `new X(...)` callee, or a `@UseGuards(...)`/decorator argument) to the
 * class declaration it statically refers to, following import aliases the
 * same way `provenance.ts`'s `checkProvenance` does. Factored out of
 * `getBaseClassDeclaration` in Phase 3 so `resolve-status.ts`'s custom-
 * exception strategy (PLAN §4.2 step 1) can resolve the class a `new
 * SomeCustomException(...)` expression instantiates with the identical
 * alias-resolution logic, rather than a second copy of it.
 *
 * Falls back to a TYPE-based lookup (`resolveClassDeclarationFromType`) when
 * `expr`'s own symbol doesn't resolve to a class declaration directly (#11)
 * — the mixin pattern, `class X extends SomeMixin(Base) {}` or `const
 * AuthGuardJwt = AuthGuard('jwt'); @UseGuards(AuthGuardJwt)`. Neither shape
 * is "a plain identifier/property access referring to a class": the first
 * is a `CallExpression` outright, whose own symbol is whatever `SomeMixin`
 * itself resolves to (a function, not a class); the second IS a plain
 * identifier, but the identifier is a `const` holding a mixin factory's
 * CALL RESULT — its symbol resolves to the `VariableDeclaration`, not a
 * class. In both cases the checker still statically knows the value's
 * TYPE (the class the mixin factory returns), which is what the fallback
 * reads instead. Checked for every `expr`, not gated on `ts.isCallExpression`
 * specifically, since the `AuthGuardJwt` identifier case needs the same
 * fallback without itself being a call expression.
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
  if (symbol) {
    const resolved = resolveAliasedSymbol(symbol, checker);
    const direct = resolved.getDeclarations()?.find(ts.isClassLike);
    if (direct) return direct;
  }

  try {
    return resolveClassDeclarationFromType(checker.getTypeAtLocation(expr));
  } catch {
    return undefined;
  }
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
