// Issue #17 / `parse-pipes.ts`: the implicit 400 from a built-in
// `Parse*Pipe` applied to a `@Param()`/`@Query()`/`@Body()` parameter, opt-in
// via `AnalysisOptions.checkParsePipes`.
import { Controller, Get, Param, ParseIntPipe, ParseUUIDPipe, Query } from '@nestjs/common';

@Controller('parse-pipes')
export class ParsePipesController {
  // A bare class reference as the second argument — must trigger the
  // implicit 400 when the check is enabled.
  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string): string {
    return id;
  }

  // An INSTANTIATED pipe (`new ParseIntPipe()`) rather than a bare class
  // reference — must be recognized the same way.
  @Get()
  list(@Query('page', new ParseIntPipe()) page: number): string {
    return String(page);
  }

  // No pipe argument at all — must never trigger the implicit 400,
  // regardless of whether the check is enabled.
  @Get('plain/:id')
  plain(@Param('id') id: string): string {
    return id;
  }
}
