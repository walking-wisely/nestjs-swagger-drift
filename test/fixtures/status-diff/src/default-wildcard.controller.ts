// `@ApiDefaultResponse` wildcard behavior (PLAN §4.3): whether this
// handler's undocumented 404 is suppressed depends entirely on
// `AnalysisOptions.treatDefaultAsWildcard`. There is no method-level or
// other class-level documentation here — this fixture exists specifically
// so a unit test can call `analyzeHandler`/`getDocumentedStatuses` directly
// with both option values and assert the difference; the CLI-driven
// `expected.json` fixture test runs with the CLI's default
// (`treatDefaultAsWildcard: false`), so this still shows up as a finding
// there.
import { Controller, Get, NotFoundException } from '@nestjs/common';
import { ApiDefaultResponse } from '@nestjs/swagger';

@Controller('default-wildcard')
export class DefaultWildcardController {
  @Get(':id')
  @ApiDefaultResponse({ description: 'default' })
  findOne(): string {
    throw new NotFoundException('not found');
  }
}
