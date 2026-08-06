// PLAN §4.1b: a service throw that IS correctly documented on the handler —
// the call graph must not manufacture a duplicate/incorrect finding once
// the real 404 it discovers is already covered by `@ApiNotFoundResponse`.
import { Controller, Get, Injectable, NotFoundException } from '@nestjs/common';
import { ApiNotFoundResponse, ApiOkResponse } from '@nestjs/swagger';

@Injectable()
export class DocumentedWidgetsService {
  findOne(id: string): string {
    if (!id) throw new NotFoundException('widget not found');
    return 'widget';
  }
}

@Controller('documented-service-widgets')
export class ServiceThrowDocumentedController {
  constructor(private readonly widgets: DocumentedWidgetsService) {}

  @Get(':id')
  @ApiOkResponse({ description: 'widget' })
  @ApiNotFoundResponse({ description: 'widget not found' })
  findOne(id: string): string {
    return this.widgets.findOne(id);
  }
}
