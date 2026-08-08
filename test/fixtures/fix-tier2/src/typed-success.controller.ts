// Positive case: a single-object success return whose type resolves to a
// class carrying `@ApiProperty()`. Tier 2 should attach `type: WidgetDto`
// (no `isArray`) and add the missing import.
import { Controller, Get } from '@nestjs/common';
import { WidgetDto } from './dto.js';

@Controller('widgets')
export class TypedSuccessController {
  @Get(':id')
  async findOne(): Promise<WidgetDto> {
    return new WidgetDto();
  }
}
