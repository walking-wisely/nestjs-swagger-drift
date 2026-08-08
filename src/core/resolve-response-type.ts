/**
 * Tier 2 autofix (PLAN §10.3): resolves a handler's concrete SUCCESS response
 * type via the `TypeChecker`, so the autofixer can attach `type: SomeDto`
 * (and `isArray: true`) to the inserted `@ApiOkResponse`/`@ApiCreatedResponse`/
 * `@ApiResponse` call instead of leaving the response body untyped.
 *
 * Scope (§10.3): success statuses only — error-status findings don't
 * generally carry a documented payload, so this module is never consulted
 * for those. `cli/fix/plan.ts` is the only caller, and only for a finding
 * whose sole deterministic source is `{ kind: 'implicit', reason: 'success' }`.
 *
 * Pure (PLAN §3's hard rule for `core/`): reads `handlerNode` and `checker`
 * only, never touches `fs`/`process`/`console`. The two gate conditions below
 * are the whole design — see PLAN §10.3 for why each exists:
 *
 * 1. The resolved type must be a **class**, not an interface or type alias
 *    — Swagger's `@ApiProperty()` reflection needs a runtime constructor.
 * 2. That class must carry **at least one `@ApiProperty()`** (or
 *    `@ApiPropertyOptional()`, its all-but-name-identical sibling) —
 *    otherwise the emitted schema is syntactically valid but empty or
 *    misleading, worse than the untyped Tier 1 stub.
 *
 * Failing either gate — or any earlier step (no signature, non-Promise
 * non-class return, `void`/`any`/`unknown`, a union, …) — is not an error:
 * it's `{ kind: 'skipped', reason }`, and `plan.ts` falls back to the Tier 1
 * stub. PLAN §4.2's "silence over noise" applies here just as much as it
 * does to status resolution: a wrong `type:` is worse than no `type:` at all.
 */

import * as ts from 'typescript';
import { getDecoratorName, getDecoratorNameNode } from './decorators.js';
import { checkProvenance } from './provenance.js';

const SWAGGER_MODULE = '@nestjs/swagger';
const API_PROPERTY_DECORATOR_NAMES = new Set(['ApiProperty', 'ApiPropertyOptional']);

export type ResponseTypeResolution =
  | {
      kind: 'resolved';
      /** The DTO class's own name, e.g. `'AccountingTemplate'`. */
      className: string;
      /** `true` when the resolved handler return type was an array of `className` (`T[]` or `Array<T>`). */
      isArray: boolean;
      /** The class's declaration — callers need this to locate its source file for import handling. */
      declaration: ts.ClassDeclaration;
    }
  | {
      kind: 'skipped';
      /** Human-readable, e.g. `'resolved type is not a class declaration'`. */
      reason: string;
    };

/** Unwraps `Promise<T>` to `T`, once — NestJS handlers are `async` or return a `Promise` directly; nested `Promise<Promise<T>>` doesn't occur in practice and isn't chased. */
function unwrapPromise(type: ts.Type, checker: ts.TypeChecker): ts.Type {
  const symbol = type.getSymbol();
  if (symbol?.getName() !== 'Promise') return type;
  if (!checker.isArrayType(type) && isTypeReference(type)) {
    const args = checker.getTypeArguments(type);
    if (args.length === 1 && args[0] !== undefined) return args[0];
  }
  return type;
}

function isTypeReference(type: ts.Type): type is ts.TypeReference {
  return (
    (type.flags & ts.TypeFlags.Object) !== 0 &&
    ((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) !== 0
  );
}

/** `true` if `classDecl` carries at least one accepted `@ApiProperty`/`@ApiPropertyOptional` member decorator (§10.3 gate 2). Name-based acceptance mirrors `decorators.ts`'s non-strict default (accept `'verified'`/`'unverified'` provenance, reject a confirmed `'mismatch'`) — a false NEGATIVE here only costs a Tier 1 fallback, so this stays conservative rather than requiring full provenance verification. */
function hasApiProperty(classDecl: ts.ClassDeclaration, checker: ts.TypeChecker): boolean {
  for (const member of classDecl.members) {
    if (!ts.isPropertyDeclaration(member) || !ts.canHaveDecorators(member)) continue;
    const decorators = ts.getDecorators(member);
    if (!decorators) continue;
    for (const decorator of decorators) {
      const nameNode = getDecoratorNameNode(decorator);
      const name = getDecoratorName(nameNode);
      if (name === undefined) continue;
      const { provenance, resolvedName } = checkProvenance(nameNode, checker, SWAGGER_MODULE);
      if (provenance === 'mismatch') continue;
      if (API_PROPERTY_DECORATOR_NAMES.has(resolvedName ?? name)) return true;
    }
  }
  return false;
}

/**
 * Resolves `handlerNode`'s concrete success response type, applying both
 * §10.3 gates. `handlerNode` should be the CONCRETE handler being analyzed
 * (`HandlerInfo.node`) — asking the checker for its signature there already
 * substitutes generics at the point of use (e.g. `CrudController<T>`'s
 * `findById(): Promise<T>` resolves to `Promise<AccountingTemplate>` when
 * `handlerNode` is reached via `AccountingTemplateController extends
 * CrudController<AccountingTemplate>`), with no manual heritage-walking
 * needed here.
 */
export function resolveSuccessResponseType(
  handlerNode: ts.MethodDeclaration,
  checker: ts.TypeChecker,
): ResponseTypeResolution {
  const signature = checker.getSignatureFromDeclaration(handlerNode);
  if (!signature) return { kind: 'skipped', reason: 'no resolvable call signature' };

  let type = unwrapPromise(checker.getReturnTypeOfSignature(signature), checker);

  let isArray = false;
  if (checker.isArrayType(type) && isTypeReference(type)) {
    const args = checker.getTypeArguments(type);
    const element = args[0];
    if (element === undefined)
      return { kind: 'skipped', reason: 'array element type not resolvable' };
    isArray = true;
    type = element;
  }

  if (type.isUnion())
    return { kind: 'skipped', reason: 'return type is a union (e.g. `T | undefined`)' };
  if (
    type.flags &
    (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Void | ts.TypeFlags.Never)
  ) {
    return { kind: 'skipped', reason: 'return type is any/unknown/void/never' };
  }

  const symbol = type.getSymbol();
  if (!symbol)
    return {
      kind: 'skipped',
      reason: 'return type has no resolvable symbol (primitive or built-in)',
    };

  const declaration = symbol.getDeclarations()?.find(ts.isClassDeclaration);
  if (!declaration) {
    return {
      kind: 'skipped',
      reason:
        'resolved type is not a class declaration (interface or type alias — no runtime constructor to reflect)',
    };
  }
  const className = declaration.name?.text;
  if (className === undefined) return { kind: 'skipped', reason: 'class declaration has no name' };

  if (!hasApiProperty(declaration, checker)) {
    return { kind: 'skipped', reason: `${className} has no @ApiProperty()-decorated members` };
  }

  return { kind: 'resolved', className, isArray, declaration };
}
