// Negative case (PLAN §10.3, gate 1 + the union case together — mirrors the
// Ever Gauzy `IPagination<T> | undefined>` finding): the return type is a
// union whose members resolve to an interface, not a class. Both the union
// check and the class-declaration gate would independently reject this;
// either is sufficient reason to fall back to the untyped Tier 1 stub.
import { Controller, Get } from '@nestjs/common';
import type { WidgetPage } from './dto.js';

@Controller('widgets')
export class InterfaceReturnController {
  @Get('page')
  async page(): Promise<WidgetPage | undefined> {
    return undefined;
  }
}
