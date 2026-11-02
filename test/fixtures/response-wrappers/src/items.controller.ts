import { Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiCommonResponses, ApiResponse } from './response.decorator.js';
import { ItemDto } from './dto.js';
import { ItemsService } from './items.service.js';

@Controller('items')
@ApiCommonResponses()
export class ItemsController {
  constructor(private readonly service: ItemsService) {}

  @Get(':id')
  @ApiResponse(ItemDto)
  find(@Param('id') id: string): string {
    return this.service.find(id);
  }

  @Post()
  @ApiResponse(ItemDto, 201)
  create(@Param('name') name: string): string {
    return this.service.create(name);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id') id: string): void {
    this.service.find(id);
  }
}
