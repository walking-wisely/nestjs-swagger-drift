// Directly `--ignore`d by the test that uses this fixture. Has no throw of
// its own — any finding it would produce, and any suppression that would
// fire, can only come from resolving the call graph into `shared.service.ts`.
import { Controller, Get } from '@nestjs/common';
import { SharedService } from './shared.service.js';

@Controller('call-graph-caller')
export class CallGraphCallerController {
  constructor(private readonly svc: SharedService) {}

  @Get(':id')
  findOne(id: string): string {
    return this.svc.findOne(id);
  }
}
