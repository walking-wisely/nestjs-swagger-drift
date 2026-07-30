/**
 * Walks a `ts.Program`'s source files, finds `@Controller` classes, and
 * collects `HandlerInfo[]` for their HTTP handlers via `core/handlers.ts`.
 *
 * CLI-only glue (PLAN.md §2.1): this is the "thin loop on top of" the pure
 * core function, not the analysis itself.
 */

import * as ts from 'typescript';
import type { HandlerInfo } from '../core/index.js';
import { getDecoratorInfos, getHandlerInfosForMethod, getHandlersForClass } from '../core/index.js';

export interface DiscoverOptions {
  /** See `HandlerDiscoveryOptions.strict` in `core/handlers.ts`. */
  strict?: boolean;
}

function isProjectSourceFile(sourceFile: ts.SourceFile): boolean {
  if (sourceFile.isDeclarationFile) return false;
  if (sourceFile.fileName.includes('/node_modules/')) return false;
  return true;
}

function forEachClassLike(
  sourceFile: ts.SourceFile,
  visitor: (node: ts.ClassLikeDeclaration) => void,
): void {
  ts.forEachChild(sourceFile, function visit(node) {
    if (ts.isClassLike(node)) visitor(node);
    ts.forEachChild(node, visit);
  });
}

/**
 * Finds every `@Controller` class in the program's own source files
 * (skipping `.d.ts` files and anything under `node_modules`) and returns
 * the flattened `HandlerInfo[]` across all of them.
 */
export function discoverHandlers(
  program: ts.Program,
  options: DiscoverOptions = {},
): HandlerInfo[] {
  const checker = program.getTypeChecker();
  const handlers: HandlerInfo[] = [];
  const discoveryOptions =
    options.strict === undefined ? { checker } : { checker, strict: options.strict };

  for (const sourceFile of program.getSourceFiles()) {
    if (!isProjectSourceFile(sourceFile)) continue;
    forEachClassLike(sourceFile, (classNode) => {
      handlers.push(...getHandlersForClass(classNode, discoveryOptions));
    });
  }

  return handlers;
}

/**
 * Every distinct `@Controller` handler *method node* in the program (as
 * opposed to `discoverHandlers`'s `HandlerInfo[]`, which yields one entry
 * per HTTP-method decorator / resolved path — a method with two decorators
 * or an array-form path would otherwise be handed to `analyzeHandler`
 * more than once for the same throws). `analyzeHandler` itself already
 * expands back out to one finding per `HandlerInfo` internally (PLAN §2.1),
 * so callers that need to *run the analyzer* should iterate this, not
 * `discoverHandlers`.
 */
export function discoverHandlerMethodNodes(
  program: ts.Program,
  options: DiscoverOptions = {},
): ts.MethodDeclaration[] {
  const checker = program.getTypeChecker();
  const discoveryOptions =
    options.strict === undefined ? { checker } : { checker, strict: options.strict };
  const nodes: ts.MethodDeclaration[] = [];

  for (const sourceFile of program.getSourceFiles()) {
    if (!isProjectSourceFile(sourceFile)) continue;
    forEachClassLike(sourceFile, (classNode) => {
      for (const member of classNode.members) {
        if (!ts.isMethodDeclaration(member)) continue;
        if (getHandlerInfosForMethod(member, discoveryOptions).length === 0) continue;
        nodes.push(member);
      }
    });
  }

  return nodes;
}

/** "Cannot find module ..." diagnostic codes from the TS checker. */
const UNRESOLVED_MODULE_DIAGNOSTIC_CODES = new Set([2307, 2792]);

/**
 * A non-fatal condition worth surfacing even though `discoverHandlers`
 * itself stays silent about it (see the Phase 1 review, B2). Two distinct
 * `kind`s, deliberately never both describing the same class in the same
 * breath — one says "accepted anyway", the other says "rejected"; a caller
 * must not print both about the same decorator:
 *
 * - `'unresolved-module'` — a semantic diagnostic names `@nestjs/common` in
 *   an unresolved-module error (not installed yet, or a monorepo's tsconfig
 *   doesn't resolve it). `core/decorators.ts` treats this as `'unverified'`
 *   and still accepts the decorator by name, so routes are NOT silently
 *   dropped — but the user should know resolution wasn't confirmed, and a
 *   caller can use this `kind` as a signal that a subsequent *empty* route
 *   table means "couldn't verify," not "verified clean."
 * - `'rejected-controller-like'` — a class carries a decorator literally
 *   named `Controller` whose provenance resolved to `'mismatch'`: the
 *   checker positively confirmed it's declared somewhere that is not
 *   `@nestjs/common`. That class contributes zero routes, which could
 *   otherwise look identical to "this file just has no controllers."
 *
 * Deliberately separate from `discoverHandlers` (which stays a pure "walk
 * and collect" loop) so callers that don't need warnings don't pay for
 * semantic diagnostics.
 */
export interface DiscoveryWarning {
  kind: 'unresolved-module' | 'rejected-controller-like';
  message: string;
}

export function collectDiscoveryWarnings(program: ts.Program): DiscoveryWarning[] {
  const checker = program.getTypeChecker();
  const warnings: DiscoveryWarning[] = [];

  for (const sourceFile of program.getSourceFiles()) {
    if (!isProjectSourceFile(sourceFile)) continue;

    for (const diagnostic of program.getSemanticDiagnostics(sourceFile)) {
      if (!UNRESOLVED_MODULE_DIAGNOSTIC_CODES.has(diagnostic.code)) continue;
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ');
      if (!message.includes('@nestjs/common')) continue;
      warnings.push({
        kind: 'unresolved-module',
        message:
          `${sourceFile.fileName}: ${message} — @nestjs/common decorators in this file could not be ` +
          `checker-verified; they were still matched by name, but this usually means the package isn't ` +
          `installed/resolvable for this tsconfig.`,
      });
    }

    forEachClassLike(sourceFile, (classNode) => {
      const decorators = getDecoratorInfos(classNode, checker);
      // Only a confirmed `'mismatch'` is "rejected" — `'unverified'` (the
      // unresolved-module case above) is accepted by name and must never
      // also produce this warning about the same class; that contradiction
      // was exactly the bug the Phase 1 review caught (B2, round 2).
      const rejected = decorators.find(
        (d) => d.name === 'Controller' && d.provenance === 'mismatch',
      );
      if (!rejected) return;
      const className =
        (ts.isClassDeclaration(classNode) || ts.isClassExpression(classNode)) && classNode.name
          ? classNode.name.text
          : '<anonymous>';
      warnings.push({
        kind: 'rejected-controller-like',
        message:
          `${sourceFile.fileName}: class "${className}" has a decorator named "Controller" that did not ` +
          `resolve to @nestjs/common and was ignored — if this was meant to be a NestJS controller, ` +
          `check for a shadowing import or local declaration.`,
      });
    });
  }

  return warnings;
}
