// The DTO is already imported (e.g. for a constructor/parameter type) --
// `ensureDtoImport` must reuse that binding rather than adding a second
// import of the same class from the same module.
import { Controller, Post, Body } from '@nestjs/common';
import { WidgetDto } from './dto.js';

@Controller('widgets')
export class ExistingDtoImportController {
  @Post()
  async create(@Body() body: WidgetDto): Promise<WidgetDto> {
    return body;
  }
}
