/**
 * Shared "does this identifier really come from module X" machinery.
 *
 * Extracted out of `decorators.ts` in Phase 2: `resolve-status.ts` (thrown
 * exception provenance against `@nestjs/common`) and `documented.ts`
 * (decorator provenance against `@nestjs/swagger`, via `decorators.ts`) both
 * need the identical checker-verification strategy, and `resolve-status.ts`
 * additionally needs it for bare expressions that are not decorators at all
 * (a `new NotFoundException(...)` callee, an `HttpStatus.NOT_FOUND` member
 * access). Keeping one implementation means both call sites inherit the same
 * "unresolved import must not be treated as a confirmed mismatch" fix
 * (see the long comment below) rather than risking it drifting between two
 * copies.
 */

import * as ts from 'typescript';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * True if `declaration` lives inside `moduleName`, checked two ways:
 *
 * 1. Its source file's path is under `node_modules/<moduleName>` — the real
 *    published package.
 * 2. It's nested inside an ambient `declare module '<moduleName>' { ... }`
 *    block, regardless of which physical file that block lives in — the
 *    shape used by hand-written `.d.ts` stubs (including this project's own
 *    test fixtures, which don't have `@nestjs/common`/`@nestjs/swagger`
 *    installed; see `decorators.ts`'s module doc).
 */
export function isDeclarationFromModule(declaration: ts.Declaration, moduleName: string): boolean {
  const pathPattern = new RegExp(`[\\\\/]node_modules[\\\\/]${escapeRegExp(moduleName)}[\\\\/]`);
  if (pathPattern.test(declaration.getSourceFile().fileName)) return true;
  for (let node: ts.Node | undefined = declaration; node !== undefined; node = node.parent) {
    if (
      ts.isModuleDeclaration(node) &&
      ts.isStringLiteral(node.name) &&
      node.name.text === moduleName
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Result of checking whether an identifier/member-access expression resolves
 * to a symbol declared by the target module:
 *
 * - `'verified'`   — the checker resolved the symbol (following import
 *                    aliases) and its declaration lives under the target
 *                    module.
 * - `'mismatch'`   — the checker resolved the symbol to an actual
 *                    declaration, but it's declared somewhere else (a
 *                    same-named local/other-library symbol). Treated as
 *                    *not* belonging to the target module.
 * - `'unverified'` — the checker could not pin the symbol down at all, or
 *                    only found the import site of an unresolved module.
 *                    Name-based fallback.
 */
export type Provenance = 'verified' | 'mismatch' | 'unverified';

export interface ProvenanceResult {
  provenance: Provenance;
  /**
   * The resolved symbol's own name (i.e. what the target module actually
   * calls this export), when the checker could determine one. Lets callers
   * match on semantic identity rather than the locally-written name, so
   * `import { NotFoundException as NotFound } from '@nestjs/common'` isn't
   * dropped just because the local name isn't `'NotFoundException'`.
   * `undefined` when unresolved.
   */
  resolvedName: string | undefined;
}

function isImportSite(declaration: ts.Declaration): boolean {
  return (
    ts.isImportSpecifier(declaration) ||
    ts.isImportClause(declaration) ||
    ts.isNamespaceImport(declaration)
  );
}

/**
 * Resolves `nameNode` (an `Identifier` or a `PropertyAccessExpression`, e.g.
 * the callee of `new NotFoundException()` or the whole `HttpStatus.NOT_FOUND`
 * access) to a `ProvenanceResult` against `moduleName`.
 */
export function checkProvenance(
  nameNode: ts.Expression,
  checker: ts.TypeChecker,
  moduleName: string,
): ProvenanceResult {
  let symbol: ts.Symbol | undefined;
  try {
    symbol = checker.getSymbolAtLocation(nameNode);
  } catch {
    symbol = undefined;
  }
  if (!symbol) return { provenance: 'unverified', resolvedName: undefined };

  let resolved = symbol;
  let aliasAdvanced = (symbol.flags & ts.SymbolFlags.Alias) === 0; // non-alias: nothing to advance past
  if (!aliasAdvanced) {
    try {
      const aliased = checker.getAliasedSymbol(symbol);
      // For an unresolved module, `getAliasedSymbol` neither throws nor
      // returns `symbol` back — it returns TS's internal "unknown symbol", a
      // real, distinct `ts.Symbol` object with zero declarations.
      // `aliased !== symbol` alone is therefore NOT proof the alias resolved
      // to something real; only a non-empty declaration list is.
      if (aliased !== symbol && (aliased.getDeclarations()?.length ?? 0) > 0) {
        resolved = aliased;
        aliasAdvanced = true;
      }
    } catch {
      // resolved stays `symbol`; aliasAdvanced stays false.
    }
  }

  const declarations = resolved.getDeclarations() ?? symbol.getDeclarations() ?? [];
  if (declarations.length === 0) return { provenance: 'unverified', resolvedName: undefined };

  // An alias that never resolved, whose only evidence is the import site
  // itself, means the checker couldn't find the other end of the import
  // (unresolved module) — not "resolved to something that isn't
  // `moduleName`". Must not be classified `mismatch`.
  if (!aliasAdvanced && declarations.every(isImportSite)) {
    return { provenance: 'unverified', resolvedName: undefined };
  }

  const fromModule = declarations.some((d) => isDeclarationFromModule(d, moduleName));
  if (!fromModule) return { provenance: 'mismatch', resolvedName: resolved.getName() };
  return { provenance: 'verified', resolvedName: resolved.getName() };
}

/** An `Identifier` or a simple `a.b` `PropertyAccessExpression`, with its resolved textual name. */
export interface NamedExpression {
  /** The node to feed into `checkProvenance` (or `checker.getSymbolAtLocation`). */
  nameNode: ts.Expression;
  /** The name as written at the use site (`'NotFoundException'`, or `'NOT_FOUND'` for `HttpStatus.NOT_FOUND`). */
  name: string;
}

/**
 * Extracts a name from a `new X(...)`/`X(...)` callee or a bare reference
 * expression, when it has the simple `Identifier` or `a.b`
 * `PropertyAccessExpression` shape every `@nestjs/common`/`@nestjs/swagger`
 * export uses. Mirrors `decorators.ts`'s decorator-name extraction, but is
 * useful beyond decorators (thrown exception class names, `HttpStatus.X`
 * member accesses), hence living here rather than there.
 */
export function getExpressionName(expr: ts.Expression): NamedExpression | undefined {
  if (ts.isIdentifier(expr)) return { nameNode: expr, name: expr.text };
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.name)) {
    return { nameNode: expr, name: expr.name.text };
  }
  return undefined;
}
