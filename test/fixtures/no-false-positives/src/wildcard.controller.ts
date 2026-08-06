// Guards against two wildcard-shaped false positives (PLAN §4.3):
//
// - The `'NXX'` range-wildcard form of `ApiResponseOptions.status`
//   (`@ApiResponse({ status: '4XX' })`) documents every status in that
//   range, including a throw that doesn't share the range's exact digits.
// - `@ApiDefaultResponse` is governed by `AnalysisOptions.treatDefaultAsWildcard`,
//   which the CLI defaults to `false` (see `cli/index.ts`'s
//   `defaultAnalysisOptions`) — this corpus runs under that same default, so
//   `@ApiDefaultResponse` alone must NOT be relied on to suppress anything
//   here. `withDefaultAndExplicit` below pairs it with an explicit, correctly
//   resolvable status to prove the wildcard decorator is at least harmless
//   (doesn't itself cause a false positive or crash resolution) without
//   depending on `treatDefaultAsWildcard: true`.
import { Controller, Get, Post, NotFoundException, ConflictException } from '@nestjs/common';
import { ApiResponse, ApiDefaultResponse, ApiOkResponse, ApiCreatedResponse } from '@nestjs/swagger';

@Controller('wildcard')
export class WildcardController {
  @Get(':id')
  @ApiOkResponse({ description: 'widget' })
  @ApiResponse({ status: '4XX', description: 'any client error' })
  findOne(): string {
    throw new NotFoundException('not found');
  }

  // `@ApiDefaultResponse` is present, but the 409 is ALSO documented
  // explicitly — so this must produce no finding regardless of
  // `treatDefaultAsWildcard`.
  @Post()
  @ApiCreatedResponse({ description: 'created' })
  @ApiDefaultResponse({ description: 'fallback for anything else' })
  @ApiResponse({ status: 409, description: 'already exists' })
  create(): string {
    throw new ConflictException('already exists');
  }
}
