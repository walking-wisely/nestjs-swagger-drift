// No `@nestjs/swagger` import at all yet — autofix must add a fresh import
// declaration, and insert the shorthand decorator for a direct throw.
import { Controller, Get, NotFoundException } from '@nestjs/common';

@Controller('widgets')
export class FreshImportController {
  @Get(':id')
  findOne(): string {
    throw new NotFoundException('widget not found');
  }
}
