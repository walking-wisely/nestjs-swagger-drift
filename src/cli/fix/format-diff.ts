/**
 * Unified diff rendering for `--fix-dry-run` (PLAN §10.2: "`--fix-dry-run`
 * ships first: unified diff per file, no writes."). Thin wrapper around the
 * `diff` package rather than a hand-rolled line-diff algorithm — nothing
 * about this problem is specific to this tool.
 */

import { createTwoFilesPatch } from 'diff';
import { relative } from 'node:path';
import type { FileFixResult } from './apply.js';

/** Renders `result` as a standard unified diff, headers relative to `baseDir` for readability. */
export function formatFileDiff(result: FileFixResult, baseDir: string): string {
  const relPath = relative(baseDir, result.file).split('\\').join('/');
  return createTwoFilesPatch(relPath, relPath, result.before, result.after, undefined, undefined, {
    context: 3,
  });
}
