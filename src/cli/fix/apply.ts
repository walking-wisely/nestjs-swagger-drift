/**
 * Tier 1 autofix mechanics (PLAN §10.2): applies a `FixPlan`'s entries as
 * real `@Api*Response`/`@ApiResponse` decorator insertions, via `ts-morph`
 * node mutation rather than text-offset patching — "avoids position drift
 * when a single file gets multiple insertions" (PLAN §10.2), which is the
 * common case (Ever Gauzy controllers averaged ~3.5 findings/file, PLAN
 * §10.0).
 *
 * `ts-morph` bundles its own `typescript` internally (`@ts-morph/common`),
 * a SEPARATE instance from the raw `typescript` compiler API `core/` and
 * the rest of the CLI use — so a `ts.Node` from `FixEntry` (the analysis
 * `ts.Program`) cannot be handed to ts-morph directly; there is no such
 * node in ts-morph's world. `FixEntry.methodStartPos` instead carries a
 * plain numeric character offset (`ts.Node.getStart()` in the ORIGINAL
 * file), which is meaningful in any tree parsed from the same unmodified
 * source text — `plan.ts` computes it, this module resolves it back to a
 * ts-morph `MethodDeclaration` via `getDescendantAtPos`.
 */

import {
  IndentationText,
  Node,
  Project,
  QuoteKind,
  SyntaxKind,
  type Decorator,
  type MethodDeclaration,
  type SourceFile,
} from 'ts-morph';
import { readFileSync } from 'node:fs';
import type { FixEntry } from './plan.js';

const SWAGGER_MODULE = '@nestjs/swagger';

/**
 * Sniffs `text`'s dominant indentation style. ts-morph's `manipulationSettings`
 * is project-wide, not inferred per file, and defaults to spaces — left as
 * `TwoSpaces` unconditionally, a tab-indented file (common in real NestJS
 * codebases; Ever Gauzy's own `app.controller.ts` is one, PLAN §10.0) got a
 * visibly inconsistent inserted line (spaces next to tabs) even though every
 * OTHER line in the file was untouched. Deliberately simple: count lines
 * starting with a tab vs. lines starting with `N` spaces before non-whitespace;
 * whichever is more common wins, spaces defaulting to two unless the smallest
 * observed space-indent is 4+ (a four-space codebase's top-level members
 * would otherwise get double-indented relative to everything else in the file).
 *
 * Block-comment continuation lines (` * foo`, the JSDoc-style block comment
 * body) are deliberately EXCLUDED from the vote: every such line has
 * exactly one leading space before the `*`, which — left in — registers as
 * a "1-space indent" and pins `minSpaceIndent` to 1 for the whole file,
 * defeating the 4+ check above even in a purely 4-space-indented file (a
 * real bug: a 4-space controller with a JSDoc block got its newly-inserted
 * decorator, and via ts-morph's own reformatting of the surrounding node,
 * some of its EXISTING lines, indented as if the file were 2-space).
 */
function detectIndentationText(text: string): IndentationText {
  let tabLines = 0;
  let minSpaceIndent: number | undefined;
  let spaceLines = 0;
  for (const line of text.split('\n')) {
    if (line.length === 0) continue;
    if (line[0] === '\t') {
      tabLines++;
      continue;
    }
    const match = /^( +)(\S)/.exec(line);
    const captured = match?.[1];
    if (captured === undefined) continue;
    // Skip block-comment continuation lines (` * ...`) — see doc comment.
    if (match?.[2] === '*') continue;
    spaceLines++;
    const indent = captured.length;
    if (minSpaceIndent === undefined || indent < minSpaceIndent) minSpaceIndent = indent;
  }
  if (tabLines > spaceLines) return IndentationText.Tab;
  if (minSpaceIndent !== undefined && minSpaceIndent >= 4) return IndentationText.FourSpaces;
  return IndentationText.TwoSpaces;
}

/** A `FixEntry` this file's mutation pass declined to insert, and why. */
export interface FixNotApplied {
  entry: FixEntry;
  /** Human-readable, e.g. `'method not found (handler moved or removed since analysis)'` or `'decorator already present'`. */
  reason: string;
}

export interface FileFixResult {
  file: string;
  before: string;
  after: string;
  /** Entries actually inserted — excludes any `entries` input already present (idempotency) or unlocatable. */
  applied: FixEntry[];
  /** Entries this file's mutation pass could not locate (handler moved/removed since analysis) or already had the decorator. */
  notApplied: FixNotApplied[];
}

/**
 * Resolves `pos` (an original-file character offset) to its enclosing
 * `MethodDeclaration` in `sourceFile`. Returns `undefined` if `pos` no
 * longer lands inside one — defensive only; `plan.ts` always derives `pos`
 * from a real handler method, so this should only trigger if the file
 * changed shape between analysis and fix (a concurrent edit, or a prior
 * `FixEntry` in this same batch already restructured the file, which
 * `applyFixesToFile` avoids by construction — see its own doc comment).
 */
function findMethodAtPos(sourceFile: SourceFile, pos: number): MethodDeclaration | undefined {
  const node = sourceFile.getDescendantAtPos(pos);
  if (!node) return undefined;
  if (node.getKind() === SyntaxKind.MethodDeclaration) {
    return node.asKindOrThrow(SyntaxKind.MethodDeclaration);
  }
  return node.getFirstAncestorByKind(SyntaxKind.MethodDeclaration);
}

/**
 * `true` if `decorator`'s first argument is an object literal with an own
 * `status: <numeric literal>` property equal to `status`. Deliberately
 * narrow and conservative, mirroring `decoratorAlreadyPresent`'s own
 * "good enough for our own output" contract: a non-object-literal argument
 * (spread, variable reference, a computed/`HttpStatus.X` value, `{ status }`
 * shorthand) can't be compared without re-implementing `documented.ts`'s
 * full resolution, so this returns `false` — "not confirmed already
 * present" — rather than guessing, in either direction.
 *
 * Originally a `firstArg.getText().includes(\`status: ${status}\`)`
 * substring search, which matched anywhere in the argument's text — a
 * nested `schema: { example: { status: 404 } }`, or free text in a
 * `description` string containing `"... { status: 423 }"` — causing the
 * autofixer to silently skip inserting a genuinely-needed decorator with no
 * indication anything was suppressed (adversarial review of PR #21).
 */
function apiResponseStatusMatches(decorator: Decorator, status: number): boolean {
  const firstArg = decorator.getArguments()[0];
  if (firstArg === undefined || !Node.isObjectLiteralExpression(firstArg)) return false;
  const statusProp = firstArg.getProperty('status');
  if (statusProp === undefined || !Node.isPropertyAssignment(statusProp)) return false;
  const initializer = statusProp.getInitializer();
  if (initializer === undefined || !Node.isNumericLiteral(initializer)) return false;
  return initializer.getLiteralValue() === status;
}

/**
 * `true` if `method` already carries a decorator that documents `entry`'s
 * status — the idempotency guard PLAN §10.2's exit criterion requires
 * ("running `--fix` a second time is a no-op"). Deliberately narrow: only
 * recognizes the EXACT decorator shape this module itself would insert (a
 * bare shorthand call, or a generic `ApiResponse({ status: N, ... })`
 * literal with `N` a real numeric-literal property, via
 * `apiResponseStatusMatches`) — good enough to make a repeated `--fix` run a
 * no-op on ITS OWN output, without trying to re-implement `documented.ts`'s
 * full resolution (constant folding, `HttpStatus.X`, spreads, ...) just to
 * decide "should I skip this insertion."
 */
function decoratorAlreadyPresent(method: MethodDeclaration, entry: FixEntry): boolean {
  return method.getDecorators().some((decorator) => {
    const name = decorator.getName();
    if (entry.isShorthand) return name === entry.decoratorName;
    if (name !== 'ApiResponse') return false;
    return apiResponseStatusMatches(decorator, entry.status);
  });
}

function decoratorArgumentText(entry: FixEntry): string {
  return entry.isShorthand
    ? `{ description: '${entry.description}' }`
    : `{ status: ${entry.status}, description: '${entry.description}' }`;
}

/**
 * Adds/dedupes a single `@nestjs/swagger` import covering every name in
 * `decoratorNames` (PLAN §10.2: "One `@nestjs/swagger` import managed/
 * deduped per file"). An existing import aliased via `as` (`import {
 * ApiResponse as Res } from '@nestjs/swagger'`) is deliberately NOT
 * recognized as already covering the plain name: the decorator text this
 * module emits always uses the PLAIN name (`entry.decoratorName`, e.g.
 * `@ApiResponse(...)`), which needs a bare `ApiResponse` binding in scope —
 * `Res` alone doesn't provide that, so treating the alias as covering it
 * would silently insert a decorator call referencing a name nothing
 * imports (`TS2304`). The "already covered" check below therefore keys on
 * each specifier's LOCAL binding (`getAliasNode()?.getText() ?? getName()`
 * — `ImportSpecifier.getName()` returns the IMPORTED name, not the alias),
 * so an alias never satisfies the plain name and a second, differently-named
 * specifier is added to the SAME declaration alongside it instead (`import
 * { ApiResponse as Res, ApiResponse } from ...`) — legal TS, two local
 * bindings for the same export.
 *
 * A TYPE-ONLY existing import (`import type { ... } from '@nestjs/swagger'`)
 * is erased at runtime, so it can never satisfy a value reference like a
 * decorator call — and appending a value specifier to it is itself a
 * compile error (TS1361, "cannot be used as a value because it was imported
 * using 'import type'"). Such a declaration is skipped entirely: both for
 * the "already covered" check (its named imports don't count) and as a
 * target to merge into. If it's the ONLY `@nestjs/swagger` import in the
 * file, a brand-new sibling value `import { ... } from '@nestjs/swagger'`
 * declaration is added instead — legal alongside a type-only import from
 * the same module.
 *
 * A NAMESPACE existing import (`import * as swagger from '@nestjs/swagger'`)
 * doesn't provide any of the bare names the emitted decorator text needs
 * either, and — separately — ts-morph's `addNamedImports` THROWS
 * `InvalidOperationError` if called on a declaration that itself has a
 * namespace import (illegal syntax: a single import declaration can't mix
 * `* as ns` and `{ named }`). Such a declaration is skipped as a merge
 * target for the same reason a type-only one is — a brand-new sibling named
 * import declaration carries the new names instead, which is legal
 * alongside a namespace import from the same module.
 */
function ensureSwaggerImport(sourceFile: SourceFile, decoratorNames: ReadonlySet<string>): void {
  if (decoratorNames.size === 0) return;

  const swaggerImports = sourceFile
    .getImportDeclarations()
    .filter((declaration) => declaration.getModuleSpecifierValue() === SWAGGER_MODULE);

  const needed = new Set(decoratorNames);
  for (const declaration of swaggerImports) {
    if (declaration.isTypeOnly()) continue;
    for (const named of declaration.getNamedImports()) {
      needed.delete(named.getAliasNode()?.getText() ?? named.getName());
    }
  }
  if (needed.size === 0) return;

  const mergeable = swaggerImports.find(
    (declaration) => !declaration.isTypeOnly() && declaration.getNamespaceImport() === undefined,
  );
  if (mergeable) {
    mergeable.addNamedImports([...needed].sort());
    return;
  }

  sourceFile.addImportDeclaration({
    moduleSpecifier: SWAGGER_MODULE,
    namedImports: [...needed].sort(),
  });
}

/** Groups `entries` (already all from the same file) by the method they target. */
function groupByMethodPos(entries: readonly FixEntry[]): Map<number, FixEntry[]> {
  const byPos = new Map<number, FixEntry[]>();
  for (const entry of entries) {
    const existing = byPos.get(entry.methodStartPos);
    if (existing) existing.push(entry);
    else byPos.set(entry.methodStartPos, [entry]);
  }
  return byPos;
}

/**
 * Applies every `entries` targeting `filePath` (all must share `file ===
 * filePath` — callers use `groupEntriesByFile`) to one in-memory ts-morph
 * `SourceFile`, and returns the before/after text without writing anything
 * — `index.ts` decides whether to diff (`--fix-dry-run`) or write
 * (`--fix`). Returns `undefined` only when `entries` was empty to begin
 * with; if every entry was skipped (already present, or unlocatable), the
 * result is still returned — `before === after` and `applied` is empty —
 * so the caller can report `notApplied`'s reasons instead of that silently
 * looking identical to "this file had nothing to fix."
 *
 * Methods are processed in DESCENDING original-position order: inserting a
 * decorator above a method shifts every position AFTER the insertion point
 * forward, so handling the last method in the file first means every
 * `methodStartPos` still to be resolved is guaranteed to be BEFORE the
 * current edit and therefore still accurate — the ts-morph-native
 * alternative to `plan.ts`'s comment about avoiding "position drift when a
 * single file gets multiple insertions" (PLAN §10.2). All of one method's
 * own entries are applied together, via the SAME `MethodDeclaration`
 * reference, before moving to the next — ts-morph keeps that reference
 * valid across its own mutations.
 */
export function applyFixesToFile(filePath: string, entries: readonly FixEntry[]): FileFixResult | undefined {
  if (entries.length === 0) return undefined;

  const rawText = readFileSync(filePath, 'utf8');
  const project = new Project({
    skipLoadingLibFiles: true,
    skipFileDependencyResolution: true,
    manipulationSettings: {
      // Single-quoted string literals: ts-morph defaults new nodes it
      // generates (a fresh import declaration, a decorator's object-literal
      // argument) to double quotes regardless of the surrounding file's own
      // style. NestJS/`@nestjs/swagger` code is single-quoted virtually
      // everywhere in practice (this whole codebase included), so this keeps
      // an inserted line from being the one double-quoted outlier — Prettier
      // would fix it anyway, but not every consumer runs Prettier on save.
      quoteKind: QuoteKind.Single,
      indentationText: detectIndentationText(rawText),
    },
  });
  const sourceFile = project.addSourceFileAtPath(filePath);
  const before = sourceFile.getFullText();

  const byMethod = [...groupByMethodPos(entries)].sort(([a], [b]) => b - a);
  const decoratorNamesNeeded = new Set<string>();
  const applied: FixEntry[] = [];
  const notApplied: FixNotApplied[] = [];

  for (const [pos, methodEntries] of byMethod) {
    const method = findMethodAtPos(sourceFile, pos);
    if (!method) {
      notApplied.push(
        ...methodEntries.map((entry) => ({
          entry,
          reason: 'method not found (handler moved or removed since analysis)',
        })),
      );
      continue;
    }
    for (const entry of methodEntries) {
      if (decoratorAlreadyPresent(method, entry)) {
        notApplied.push({ entry, reason: 'decorator already present' });
        continue;
      }
      // `insertDecorator(0, ...)` — prepend, not `addDecorator` (append) —
      // deliberately: appending inserts the new decorator text between the
      // LAST existing decorator and the method itself, which is exactly
      // where a trailing line comment on that last decorator's own line
      // lives (`@Get('/') // handles root`). ts-morph's insertion there
      // reassociates that comment with the NEW decorator instead of the one
      // it was actually commenting on — a real "we moved your comment" bug
      // found running this against Ever Gauzy (PLAN §10.0). Inserting at
      // the front instead only ever touches the boundary right after the
      // method's own leading trivia/JSDoc, never between two existing
      // decorators, so no existing trailing comment is ever in the blast
      // radius.
      method.insertDecorator(0, { name: entry.decoratorName, arguments: [decoratorArgumentText(entry)] });
      decoratorNamesNeeded.add(entry.decoratorName);
      applied.push(entry);
    }
  }

  // `entries.length > 0` (checked above) plus every entry landing in either
  // `applied` or `notApplied` means `applied.length === 0` here only when
  // EVERY entry was skipped — still worth returning, not `undefined`, so the
  // caller can report why (issue 7 / adversarial review of PR #21): a
  // `--fix` run that skips insertions must not look identical to a run that
  // had nothing to do in the first place.
  if (applied.length === 0 && notApplied.length === 0) return undefined;

  ensureSwaggerImport(sourceFile, decoratorNamesNeeded);

  return { file: filePath, before, after: sourceFile.getFullText(), applied, notApplied };
}
