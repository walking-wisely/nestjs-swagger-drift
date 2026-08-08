// Positive case, array form: `Promise<WidgetDto[]>` should resolve with
// `isArray: true` alongside `type: WidgetDto`.
import { Controller, Get } from '@nestjs/common';
import { WidgetDto } from './dto.js';

@Controller('widgets')
export class TypedArrayController {
  @Get()
  async findAll(): Promise<WidgetDto[]> {
    return [];
  }
}
