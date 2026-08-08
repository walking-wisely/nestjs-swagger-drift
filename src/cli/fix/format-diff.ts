/**
 * Unified diff rendering for `--fix-dry-run` (PLAN §10.2: "`--fix-dry-run`
 * ships first: unified diff per file, no writes."). Thin wrapper around the
 * `diff` package rather than a hand-rolled line-diff algorithm — nothing
 * about this problem is specific to this tool.
 */

import { createTwoFilesPatch } from 'diff';
import { relative } from 'node:path';
import type { FileFixResult } from './apply.js';

/**
 * Matches C0 controls (except `\t`, `\n`, `\r` — legitimate whitespace) and
 * C1 controls. `--fix-dry-run` echoes `result.before`/`result.after` —
 * SOURCE-derived text from the analyzed file — straight to the terminal via
 * `formatFileDiff`; without this, a string literal in that source containing
 * a raw ESC (`\x1b`) byte (e.g. an embedded ANSI escape sequence) would reach
 * the victim's terminal verbatim, letting an attacker-controlled file being
 * analyzed (CI, a malicious dependency/fixture, ...) move the cursor, clear
 * the screen, recolor text, or set the window title on whoever runs
 * `--fix-dry-run` against it. This is new attack surface introduced by
 * shipping a diff of raw source content — nothing upstream of this ever
 * wrote source bytes straight to the terminal.
 */
// eslint-disable-next-line no-control-regex -- deliberately matching control bytes to strip them
const CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;

/** Strips control bytes (see `CONTROL_CHARS`) from source-derived text before it reaches the terminal. */
function sanitizeForTerminal(text: string): string {
  return text.replace(CONTROL_CHARS, '');
}

/** Renders `result` as a standard unified diff, headers relative to `baseDir` for readability. */
export function formatFileDiff(result: FileFixResult, baseDir: string): string {
  const relPath = relative(baseDir, result.file).split('\\').join('/');
  const before = sanitizeForTerminal(result.before);
  const after = sanitizeForTerminal(result.after);
  return createTwoFilesPatch(relPath, relPath, before, after, undefined, undefined, {
    context: 3,
  });
}
