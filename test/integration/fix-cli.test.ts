/**
 * Defense in depth for `--fix`'s per-file loop (`src/cli/index.ts`): one
 * pathological file `applyFixesToFile` can't handle must not abort the
 * whole batch and surface as `EXIT_UNEXPECTED_ERROR` — by the time a later
 * file in the batch throws, EARLIER files may already have been written to
 * disk, so an uncaught propagation out of `main()` would leave a
 * partially-fixed, uncommitted working tree with no summary of what
 * happened (see the PR review this test reproduces). `applyFixesToFile`
 * itself is mocked to throw for exactly one file — the fix under test is
 * the per-file `try`/`catch` in `main()`'s loop, not any particular error
 * source, so a synthetic throw is the precise and stable way to exercise it
 * (an ACTUAL unhandled-shape crash is also covered, non-synthetically, by
 * `test/integration/fix.test.ts`'s namespace-import case — which used to
 * crash here before that bug was fixed).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, '../fixtures/fix-tier1');

const tempDirs: string[] = [];
afterEach(() => {
  vi.doUnmock('../../src/cli/fix/apply.js');
  vi.resetModules();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('--fix per-file failure isolation', () => {
  it('a file that throws inside applyFixesToFile is skipped with a named warning; other files in the same batch still get fixed and written', async () => {
    vi.doMock('../../src/cli/fix/apply.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../src/cli/fix/apply.js')>();
      return {
        ...actual,
        applyFixesToFile: (filePath: string, entries: Parameters<typeof actual.applyFixesToFile>[1]) => {
          if (filePath.endsWith('fresh-import.controller.ts')) {
            throw new Error('boom: synthetic pathological-file failure');
          }
          return actual.applyFixesToFile(filePath, entries);
        },
      };
    });

    const { main, EXIT_UNEXPECTED_ERROR } = await import('../../src/cli/index.js');

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swagger-drift-fix-cli-'));
    tempDirs.push(tmp);
    fs.cpSync(FIXTURE_DIR, tmp, { recursive: true });

    const errors: string[] = [];
    const errorSpy = vi.spyOn(console, 'error').mockImplementation((msg: string) => {
      errors.push(String(msg));
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    let code: number;
    try {
      code = await main(['--project', join(tmp, 'tsconfig.json'), '--fix']);
    } finally {
      errorSpy.mockRestore();
      logSpy.mockRestore();
    }

    // No crash: `main()` completed and returned a real exit code, not
    // `EXIT_UNEXPECTED_ERROR` (and definitely didn't throw/reject).
    expect(code).not.toBe(EXIT_UNEXPECTED_ERROR);

    // The failing file is named in a warning, not silently swallowed.
    expect(
      errors.some((e) => e.includes('fresh-import.controller.ts') && e.includes('boom: synthetic')),
    ).toBe(true);
    // The final summary reports it as skipped.
    expect(errors.some((e) => e.includes('skipped due to errors') && e.includes('fresh-import.controller.ts'))).toBe(
      true,
    );

    // A DIFFERENT file in the same batch — processed either before or after
    // the failing one — still got its fix written to disk.
    const existingImportAfter = fs.readFileSync(join(tmp, 'src/existing-import.controller.ts'), 'utf8');
    expect(existingImportAfter).toContain('ApiConflictResponse');

    // The failing file itself was never written (still its original text).
    const freshImportAfter = fs.readFileSync(join(tmp, 'src/fresh-import.controller.ts'), 'utf8');
    expect(freshImportAfter).not.toContain('ApiNotFoundResponse');
  });
});
