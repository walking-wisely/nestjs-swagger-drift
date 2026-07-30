// Class-level `@ApiResponse`-family decorators apply to every handler on
// the class (PLAN §4.3) — this handler has no method-level documentation at
// all, only the class-level `@ApiForbiddenResponse`, and must produce no
// finding.
import { Controller, Get, ForbiddenException } from '@nestjs/common';
import { ApiForbiddenResponse } from '@nestjs/swagger';

@Controller('class-level-documented')
@ApiForbiddenResponse({ description: 'no access' })
export class ClassLevelController {
  @Get()
  list(): string {
    throw new ForbiddenException('no access');
  }
}
