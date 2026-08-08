// Already has a `@nestjs/swagger` import (for an unrelated decorator) —
// autofix must add a named import to the EXISTING declaration, not create a
// second one. The finding here is a `service-throw` (one hop into
// `ExistingImportService.update`), exercising Tier 1's "resolved within
// --max-depth" fixable case.
import { Controller, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ExistingImportService } from './existing-import.service.js';

@ApiTags('existing')
@Controller('existing')
export class ExistingImportController {
  constructor(private readonly service: ExistingImportService) {}

  @Post()
  update(): void {
    this.service.update();
  }
}
