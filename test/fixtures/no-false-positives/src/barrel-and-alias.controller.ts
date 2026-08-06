// Guards against false positives when exceptions/decorators are re-exported
// through a local barrel (`./barrel.ts`, `export * from '@nestjs/common'`)
// and/or imported under an alias — both must still resolve to `@nestjs/common`
// / `@nestjs/swagger` via `provenance.ts`'s checker-based resolution, not
// name matching alone.
import { Controller, Get, ApiConflictResponse, ApiOkResponse } from './barrel.js';
import { NotFoundException as NotFound, ConflictException as Conflict } from '@nestjs/common';
import { ApiNotFoundResponse as DocNotFound } from '@nestjs/swagger';

@Controller('barrel-and-alias')
export class BarrelAndAliasController {
  // `@Controller`/`@Get` resolved through the barrel; `NotFoundException`
  // thrown under an aliased import name; documented via an aliased shorthand
  // decorator import.
  @Get(':id')
  @ApiOkResponse({ description: 'widget' })
  @DocNotFound({ description: 'not found' })
  findOne(id: string): string {
    if (!id) throw new NotFound('missing id');
    return 'widget';
  }

  // Same idea, but the thrown exception is documented via the barrel's own
  // re-exported (non-aliased) shorthand decorator, resolved through the
  // barrel too.
  @Get('conflict-check/:id')
  @ApiOkResponse({ description: 'widget' })
  @ApiConflictResponse({ description: 'already exists' })
  findConflict(): string {
    throw new Conflict('already exists');
  }
}
