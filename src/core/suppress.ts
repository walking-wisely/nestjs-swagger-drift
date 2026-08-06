/**
 * Inline suppression comments (PLAN.md §5 Phase 4): `// swagger-drift-disable-next-line 404`
 * silences a specific status finding without touching `AnalysisOptions`.
 *
 * Deliberately lives in `core/`, not `cli/`: the whole point is that a
 * suppression travels with the source it suppresses and works identically
 * under the CLI and the future ESLint adapter (PLAN §2.1) — an ESLint rule
 * reports one node at a time and has no report-formatting layer of its own
 * to hook a CLI-side suppression pass into. This module only reads
 * `ts.Node`/`ts.SourceFile` (comment trivia, line numbers) — no `fs`, no
 * `path`, nothing Node-specific — so the PLAN §3 boundary holds.
 *
 * ## Placement: directly above the suppressed node, "next line" style
 *
 * Mirrors `eslint-disable-next-line`: the comment must be the *last* leading
 * comment attached to the node and must end on the line immediately before
 * the node's own first token. `node.getFullStart()`'s leading trivia can
 * stretch back arbitrarily far (blank lines, unrelated comments, the
 * previous statement's trailing trivia in some ASTs) — this module only
 * honors a comment that is actually adjacent, not merely "somewhere above."
 *
 * Two positions are checked for a given node, not one, because a comment
 * "directly above" a `ts.Node` in the geometric sense a user actually writes
 * it doesn't always land as that node's own leading trivia in the AST
 * (post-Phase-4-review fix — findings S5/S6):
 *
 * - **Handlers**: a method's decorators are ordinary child nodes (part of
 *   `modifiers`), so `node.getStart()` for a decorated method lands on the
 *   first decorator's `@` — a comment above the decorators already works via
 *   the plain node check. But a comment placed *between* the last decorator
 *   and the method name (`@Get()\n// ...\nfindOne()`) is nobody's leading
 *   trivia at the method-declaration level; it's only visible by also
 *   checking the method's own `name` node. `checkHandlerSuppression` checks
 *   both positions.
 * - **Sources** (a `throw`, or a service-throw's origin): the ubiquitous
 *   `if (!x) throw new NotFoundException();` idiom puts the `throw` on the
 *   same line as its `if`, so a comment above the `if` is the `if`
 *   statement's leading trivia, not the (nested) `ThrowStatement`'s.
 *   `checkSourceSuppression` also checks the node's *enclosing statement* —
 *   walking up to the nearest ancestor that is itself a `ts.Statement`
 *   sitting directly in a statement list (a function/block body, a `case`
 *   arm, ...) — so a directive above the `if` suppresses the `throw` inside
 *   it.
 *
 * ## Where it's checked (see `analyze.ts`)
 *
 * `analyzeHandler` checks two kinds of node for a given `(status)` before
 * emitting a finding: the handler method declaration itself (suppresses
 * that status for that handler regardless of how many sources produce it),
 * and every individual `StatusSource.node` that contributes to the status
 * (a direct `throw`, or — deliberately — a `service-throw`'s throw statement
 * in the callee's own file). Allowing suppression at a `service-throw`'s
 * origin is intentional: the person closest to a shared service throw is
 * often better positioned to say "this is handled/acceptable" than every
 * caller repeating the same suppression, and it's the same "silence over
 * noise" bias PLAN §4.2 already applies to custom exception resolution.
 * The tradeoff (a suppression in a shared file silently affects every
 * caller) is real but symmetric with call-graph traversal itself already
 * attributing one service throw to every caller — this doesn't introduce a
 * new class of action-at-a-distance, it uses the same one the call graph
 * already relies on. It's made observable, not just defensible, by
 * `analyzeHandler`'s optional `onSuppressed` callback (see its doc comment)
 * and by `listDirectiveCommentLines` below, which together let a caller
 * report both how many findings a suppression silenced and which directive
 * comments never silenced anything at all.
 *
 * ## Argument grammar
 *
 * - `// swagger-drift-disable-next-line` (no status list) suppresses every
 *   status that would otherwise be reported at that location.
 * - `// swagger-drift-disable-next-line 404` suppresses only `404`.
 * - `// swagger-drift-disable-next-line 404, 409` (comma and/or whitespace
 *   separated) suppresses both. Any other status still fires normally.
 *
 * The status list, if present, must be the first non-blank content after
 * the keyword — anchored to a strict `\d{3}(\s*,\s*\d{3})*` grammar at the
 * *start* of that content, not scanned for anywhere in the rest of the
 * comment (post-Phase-4-review fix — findings S3/S4):
 *
 * - `// swagger-drift-disable-next-line 404 (see ticket 409)` suppresses
 *   only `404` — the trailing parenthetical isn't scanned for stray digits,
 *   so the ticket number `409` is never mistaken for a second status.
 * - `// swagger-drift-disable-next-line -- tracked in JIRA-409` doesn't
 *   start with a status list at all, so it means "suppress everything," not
 *   "suppress 409."
 * - The "first non-blank content" is checked line by line (not just on the
 *   directive's own line), so a block comment that pushes its status list to
 *   a continuation line — `/* swagger-drift-disable-next-line\n 409 *\/` —
 *   still parses as "suppress 409," not "suppress everything" (which is what
 *   a `.`-based regex that can't cross newlines used to silently do). A
 *   leading `*` continuation marker (`/**\n * swagger-drift-disable-next-line\n * 409\n *\/`)
 *   is stripped before matching, since that's how people already write
 *   multi-line JSDoc-style block comments.
 *
 * Both `//` and `/* *\/` comment forms are accepted — the regex is applied to
 * the comment's raw text (delimiters included), so the directive can appear
 * anywhere inside either form.
 */

import * as ts from 'typescript';

const DIRECTIVE_PATTERN = /swagger-drift-disable-next-line\b/;
const STATUS_LIST_PATTERN = /^(\d{3}(?:\s*,\s*\d{3})*)/;

type Directive = { statuses: 'all' } | { statuses: ReadonlySet<number> };

function parseDirective(commentText: string): Directive | undefined {
  const match = DIRECTIVE_PATTERN.exec(commentText);
  if (!match) return undefined;

  const rest = commentText.slice(match.index + match[0].length);
  for (const line of rest.split('\n')) {
    const cleaned = line
      .trim()
      .replace(/^\*\s*/, '') // a block-comment continuation line's leading `*`
      .replace(/\*\/\s*$/, ''); // a trailing `*/` on the same line as the list
    if (cleaned.length === 0) continue; // keep looking for the first real content
    const listMatch = STATUS_LIST_PATTERN.exec(cleaned);
    if (!listMatch) return { statuses: 'all' };
    const codes = (listMatch[1] ?? '').split(',').map((s) => Number(s.trim()));
    return { statuses: new Set(codes) };
  }
  return { statuses: 'all' };
}

export interface SuppressionCheck {
  suppressed: boolean;
  /** 1-based line of the directive comment that matched, when `suppressed` is `true`. */
  directiveLine?: number;
}

/**
 * The core adjacency check: does `node` have a `swagger-drift-disable-next-line`
 * directive immediately above it (see module doc) that names `status`, or
 * names no statuses at all? Callers that need to check more than one
 * position for a single logical suppression target (a handler, a source —
 * see module doc) use `checkHandlerSuppression`/`checkSourceSuppression`
 * below rather than calling this directly.
 */
function checkNode(node: ts.Node, status: number): SuppressionCheck {
  const sourceFile = node.getSourceFile();
  // Nodes built by `test/helpers/in-memory-program.ts` and hand-rolled unit
  // fixtures always carry a real `ts.SourceFile`, but this guards defensively
  // against any future caller handing in a detached node.
  if (sourceFile === undefined) return { suppressed: false };

  const text = sourceFile.text;
  const ranges = ts.getLeadingCommentRanges(text, node.getFullStart());
  if (ranges === undefined || ranges.length === 0) return { suppressed: false };

  const nodeStartLine = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line;

  for (const range of ranges) {
    const directive = parseDirective(text.slice(range.pos, range.end));
    if (directive === undefined) continue;

    // Must be the line immediately before the node's own first token —
    // an otherwise-matching directive two lines up (a stray blank line, or
    // attached to a different, earlier comment block) does not suppress.
    const commentEndLine = sourceFile.getLineAndCharacterOfPosition(range.end).line;
    if (commentEndLine !== nodeStartLine - 1) continue;

    if (directive.statuses === 'all' || directive.statuses.has(status)) {
      const directiveLine = sourceFile.getLineAndCharacterOfPosition(range.pos).line + 1;
      return { suppressed: true, directiveLine };
    }
  }

  return { suppressed: false };
}

/**
 * `true` if `node` has a `swagger-drift-disable-next-line` directive
 * immediately above it (see module doc) that names `status`, or names no
 * statuses at all (a bare disable-next-line suppresses everything at that
 * location). The single-position primitive — kept as the module's public,
 * directly-testable building block; `analyze.ts` uses
 * `checkHandlerSuppression`/`checkSourceSuppression` instead, which also
 * cover the positions documented above where a directive is geometrically
 * "directly above" a node without being that node's own leading trivia.
 */
export function isStatusSuppressed(node: ts.Node, status: number): boolean {
  return checkNode(node, status).suppressed;
}

/**
 * Checks both positions a suppression above a handler can land: the method
 * declaration's own leading trivia (covers a directive above the decorators,
 * since decorators are part of the method node), and — when `handlerNode` is
 * a method declaration — its `name` node's leading trivia (covers a
 * directive placed between the last decorator and the method name).
 */
export function checkHandlerSuppression(handlerNode: ts.Node, status: number): SuppressionCheck {
  const direct = checkNode(handlerNode, status);
  if (direct.suppressed) return direct;
  if (ts.isMethodDeclaration(handlerNode)) {
    const atName = checkNode(handlerNode.name, status);
    if (atName.suppressed) return atName;
  }
  return { suppressed: false };
}

function isStatementListParent(node: ts.Node): boolean {
  return (
    ts.isBlock(node) ||
    ts.isSourceFile(node) ||
    ts.isModuleBlock(node) ||
    ts.isCaseClause(node) ||
    ts.isDefaultClause(node)
  );
}

/**
 * Walks up from `node` to the nearest ancestor that is itself a `ts.Statement`
 * sitting directly in a statement list (a function/block body, a `case`/
 * `default` arm, a module body, the source file itself) — i.e. the statement
 * a comment placed directly above it, in the geometric sense a user actually
 * writes, would attach to as leading trivia. For `throw new X()` inside a
 * braced block, that's the `ThrowStatement` itself. For the unbraced
 * `if (!x) throw new X();` idiom, `node`'s immediate parent is the
 * `IfStatement` (not a statement-list container), so this keeps walking up
 * and returns the `IfStatement` — the node a directive placed above the
 * whole `if` actually attaches to.
 */
function findEnclosingStatement(node: ts.Node): ts.Node | undefined {
  let current: ts.Node = node;
  while (current.parent !== undefined) {
    if (ts.isStatement(current) && isStatementListParent(current.parent)) return current;
    current = current.parent;
  }
  return undefined;
}

/**
 * Checks both positions a suppression above a `StatusSource` can land: the
 * source node itself (a `ThrowStatement`), and — when the throw isn't
 * itself directly in a statement list (the unbraced `if (!x) throw ...;`
 * idiom) — its enclosing statement. See `findEnclosingStatement`.
 */
export function checkSourceSuppression(node: ts.Node, status: number): SuppressionCheck {
  const direct = checkNode(node, status);
  if (direct.suppressed) return direct;
  const enclosing = findEnclosingStatement(node);
  if (enclosing !== undefined && enclosing !== node) {
    const atEnclosing = checkNode(enclosing, status);
    if (atEnclosing.suppressed) return atEnclosing;
  }
  return { suppressed: false };
}

// Anchored to "the keyword is the first thing after the comment opener"
// (optional leading `//`, `/*`, or a block-comment continuation `*`), not a
// bare substring search — a doc comment that merely *mentions* the feature
// in prose (`// See the swagger-drift-disable-next-line directive below`,
// or this very module's own doc comment) must not be flagged as a directive
// that "suppressed nothing." Caught by this repo's own status-diff fixture:
// `suppressed.controller.ts`'s header comment describes the feature by name
// several lines above the real directive, and a bare substring scan flagged
// it as an unused directive on every CLI run over that fixture.
//
// The trailing `\s*` is nested *inside* the optional comment-opener group
// rather than sitting as a separate top-level `\s*` after it (i.e. NOT
// `^\s*(?:\/\/|\/\*|\*)?\s*keyword`). Two adjacent unbounded `\s*`
// quantifiers with only an optional, easily-skipped group between them let
// the engine re-partition the same run of whitespace across both
// quantifiers in exponentially/polynomially many ways before it can report
// "no match" (classic ReDoS shape — CodeQL js/polynomial-redos). Since this
// runs once per source line of every analyzed file, an attacker-controlled
// or merely very-long non-matching line (e.g. a long blank/whitespace line)
// could take quadratic time. Folding the second `\s*` into the group
// removes the ambiguity: whitespace after a comment opener is only ever
// consumed once, by the group's own `\s*`, and is never reachable from the
// leading `^\s*` too.
const DIRECTIVE_LINE_PATTERN = /^\s*(?:(?:\/\/|\/\*|\*)\s*)?swagger-drift-disable-next-line\b/;

/**
 * Every line in `sourceFile` that looks like it carries a
 * `swagger-drift-disable-next-line` directive, 1-based. A plain text scan,
 * not a comment-trivia walk: cheap (one pass over the file's text, no AST
 * traversal), and good enough for a diagnostic rather than for suppression
 * itself — a caller (`cli/index.ts`) cross-references this against the set
 * of directive lines that actually suppressed something (via
 * `analyzeHandler`'s `onSuppressed` callback) to warn about directives that
 * suppressed nothing at all (PLAN §5 Phase 4 review, finding S5/S6): a typo'd
 * placement, a status that was never going to be reported anyway, or a
 * directive left behind after the throw it targeted was removed. Remaining
 * false positives (the keyword sitting right after a comment opener, inside
 * a string/template literal rather than an actual comment) only ever make
 * the diagnostic warn about a line that isn't really a directive — never the
 * reverse, and never affects suppression itself, which only ever reads real
 * comment trivia.
 */
export function listDirectiveCommentLines(sourceFile: ts.SourceFile): number[] {
  const lines = sourceFile.text.split('\n');
  const result: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (DIRECTIVE_LINE_PATTERN.test(lines[i] ?? '')) result.push(i + 1);
  }
  return result;
}
