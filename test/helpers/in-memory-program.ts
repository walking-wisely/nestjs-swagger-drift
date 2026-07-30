/**
 * Builds a `ts.Program` entirely from in-memory source, for unit tests that
 * need a real checker but don't want a fixture directory on disk (e.g.
 * exercising a specific decorator mode that would conflict with the shared
 * fixtures' `experimentalDecorators` setting).
 */

import * as ts from 'typescript';

export function createInMemoryProgram(
  files: Record<string, string>,
  rootNames: string[],
  options: ts.CompilerOptions,
): ts.Program {
  const sourceFiles = new Map<string, ts.SourceFile>();
  for (const [fileName, content] of Object.entries(files)) {
    sourceFiles.set(fileName, ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true));
  }

  const host = ts.createCompilerHost(options);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile) => {
    const found = sourceFiles.get(fileName);
    if (found) return found;
    return originalGetSourceFile(
      fileName,
      languageVersionOrOptions,
      onError,
      shouldCreateNewSourceFile,
    );
  };
  host.fileExists = (f) => sourceFiles.has(f) || ts.sys.fileExists(f);
  host.readFile = (f) => sourceFiles.get(f)?.text ?? ts.sys.readFile(f);

  return ts.createProgram(rootNames, options, host);
}
