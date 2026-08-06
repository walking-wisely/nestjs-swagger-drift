// m6 (Phase 6 ESLint-plugin review): see `unresolvable-cross-file.service.ts`
// for why this pair of files exists — the handler's own body never throws
// anything; the unresolvable throw lives one call-graph hop away, in a
// different file's AST.
import { Controller, Get } from '@nestjs/common';
import { FlakyCrossFileService } from './unresolvable-cross-file.service.js';

@Controller('unresolvable-cross-file')
export class UnresolvableCrossFileController {
  constructor(private readonly flaky: FlakyCrossFileService) {}

  @Get(':id')
  viaService(id: string): string {
    return this.flaky.check(id);
  }
}
