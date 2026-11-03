import { Controller, Get, Param } from '@nestjs/common';
import { ApiResponse } from './response.decorator.js';
import { ItemDto } from './dto.js';
import { ItemsService } from './items.service.js';

@Controller('bare')
export class BareController {
  constructor(private readonly service: ItemsService) {}

  @Get()
  @ApiResponse(ItemDto, 404)
  list(@Param('name') name: string): string {
    return this.service.create(name);
  }
}
