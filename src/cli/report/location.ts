/**
 * Node → reportable-location conversion, shared by both reporters
 * (`pretty.ts`, `json.ts`).
 *
 * `core/` hands out `ts.Node`s whose source files carry whatever absolute
 * (or cwd-relative-as-given-to-the-compiler) path `ts.createProgram` used —
 * `core/` itself stays Node-free and must not know about `cwd`/`baseDir` at
 * all (PLAN §3), so the relative-path conversion PLAN §4.4's report format
 * wants (`src/users/users.controller.ts:42:3`, not an absolute path —
 * breaks editor/CI annotation linking otherwise) lives here, in `cli/`,
 * only.
 *
 * `baseDir` is the tsconfig's own directory by default as of Phase 4 (see
 * `index.ts`'s `resolveBaseDir` and its doc comment for why `cwd` was the
 * wrong default), overridable via `--base-dir`.
 */

import * as ts from 'typescript';
import { relative } from 'node:path';

export interface Location {
  /** `baseDir`-relative path, always `/`-separated regardless of platform. */
  file: string;
  /** 1-based line number. */
  line: number;
  /** 1-based column number. */
  column: number;
}

export function locationOf(node: ts.Node, baseDir: string): Location {
  const sourceFile = node.getSourceFile();
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
  const relativePath = relative(baseDir, sourceFile.fileName) || sourceFile.fileName;
  return { file: relativePath.split('\\').join('/'), line: line + 1, column: character + 1 };
}

export function formatLocation(location: Location): string {
  return `${location.file}:${location.line}:${location.column}`;
}
