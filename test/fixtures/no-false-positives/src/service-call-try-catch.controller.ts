// PLAN §4.1b's single biggest false-positive risk, made concrete: a call
// into a throwing service, wrapped in a `try`/`catch` AT THE CALL SITE.
// `thrown.ts`'s "a throw inside a caught `try` block is not producible" rule
// must apply transitively to a *call* reached through that same try block —
// the service's throw never reaches this handler's caller. Getting this
// wrong reproduces the worst false positive found in Phase 2, transitively.
import { Controller, Get, Injectable, NotFoundException } from '@nestjs/common';

@Injectable()
export class SwallowedWidgetsService {
  findOne(id: string): string {
    if (!id) throw new NotFoundException('widget not found');
    return 'widget';
  }
}

@Controller('swallowed-service-widgets')
export class ServiceCallTryCatchController {
  constructor(private readonly widgets: SwallowedWidgetsService) {}

  @Get(':id')
  findOne(id: string): string | null {
    try {
      return this.widgets.findOne(id);
    } catch {
      return null;
    }
  }
}
