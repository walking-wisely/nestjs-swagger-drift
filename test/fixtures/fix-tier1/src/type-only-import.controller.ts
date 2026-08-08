// Existing `@nestjs/swagger` import is TYPE-ONLY (`import type { ... }`).
// It's erased at runtime, so it can never satisfy a value reference —
// appending a value specifier (e.g. `ApiNotFoundResponse`) to it is a
// compile error (TS1361, "cannot be used as a value because it was
// imported using 'import type'"). Autofix must add a SEPARATE value import
// declaration instead of mutating this one.
import { Controller, Get, NotFoundException } from '@nestjs/common';
import type { ApiResponseOptions } from '@nestjs/swagger';

const LEGACY_OPTIONS: ApiResponseOptions = { description: 'legacy, unused by autofix' };

@Controller('type-only')
export class TypeOnlyImportController {
  @Get(':id')
  findOne(): string {
    console.log(LEGACY_OPTIONS);
    throw new NotFoundException('widget not found');
  }
}
