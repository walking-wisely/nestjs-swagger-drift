import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const bin = join(root, 'dist/cli/index.js');
const CONTROLLERS = 200;

describe.skipIf(!existsSync(bin))('built binary with a report over 64KB', () => {
  it('writes the whole JSON document to a pipe', () => {
    const dir = mkdtempSync(join(tmpdir(), 'drift-large-'));
    try {
      cpSync(join(root, 'test/fixtures/guard-guarantees/types'), join(dir, 'types'), {
        recursive: true,
      });
      cpSync(
        join(root, 'test/fixtures/guard-guarantees/tsconfig.json'),
        join(dir, 'tsconfig.json'),
      );
      for (let i = 0; i < CONTROLLERS; i++) {
        writeFileSync(
          join(dir, `src-c${i}.ts`),
          `import { Controller, Get, NotFoundException } from '@nestjs/common';
@Controller('c${i}')
export class C${i}Controller {
  @Get()
  find() {
    throw new NotFoundException('missing ${'x'.repeat(40)}');
  }
}
`,
        );
      }
      writeFileSync(
        join(dir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            target: 'ES2022',
            module: 'nodenext',
            moduleResolution: 'nodenext',
            experimentalDecorators: true,
            strict: true,
            skipLibCheck: true,
            noEmit: true,
          },
          include: ['*.ts', 'types'],
        }),
      );

      const result = spawnSync(
        process.execPath,
        [bin, '--project', join(dir, 'tsconfig.json'), '--reporter', 'json', '--no-config'],
        { cwd: dir, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
      );

      expect(result.stdout.length).toBeGreaterThan(65536);
      const parsed = JSON.parse(result.stdout) as { findings: unknown[] };
      expect(parsed.findings.length).toBeGreaterThanOrEqual(CONTROLLERS);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
