// Existing `@nestjs/swagger` import uses an ALIAS (`ApiResponse as Res`).
// `ImportSpecifier.getName()` returns the IMPORTED name ("ApiResponse"),
// not the local binding ("Res") — autofix must key its "already imported"
// check on the local binding, not the imported name, or it wrongly treats
// this as already covering `ApiNotFoundResponse` and never imports it,
// while still emitting a bare `@ApiNotFoundResponse(...)` call that has no
// binding in scope.
import { Controller, Get, NotFoundException } from '@nestjs/common';
import { ApiResponse as Res } from '@nestjs/swagger';

@Res({ description: 'existing, hand-written' })
@Controller('aliased')
export class AliasedImportController {
  @Get(':id')
  findOne(): string {
    throw new NotFoundException('widget not found');
  }
}
