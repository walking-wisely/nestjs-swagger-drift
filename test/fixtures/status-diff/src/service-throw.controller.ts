// PLAN §4.1b: the handler itself throws nothing directly — the 404 is only
// reachable by resolving the call into `WidgetsService.findOne`. Nothing
// documents 404 here, so this must produce exactly one `undocumented-status`
// finding, with a `service-throw` source carrying `via: ['WidgetsService.findOne']`.
import { Controller, Get } from '@nestjs/common';
import { WidgetsService } from './service-throw.service.js';

@Controller('service-widgets')
export class ServiceThrowController {
  constructor(private readonly widgets: WidgetsService) {}

  @Get(':id')
  findOne(id: string): string {
    return this.widgets.findOne(id);
  }
}
