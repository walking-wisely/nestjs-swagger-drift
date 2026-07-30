// Correct documentation via the generic `@ApiResponse({ status: N })` form —
// must produce no finding.
import { Controller, Get, NotFoundException } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';

@Controller('generic-documented')
export class DocumentedGenericController {
  @Get(':id')
  @ApiResponse({ status: 404, description: 'not found' })
  findOne(): string {
    throw new NotFoundException('not found');
  }
}
