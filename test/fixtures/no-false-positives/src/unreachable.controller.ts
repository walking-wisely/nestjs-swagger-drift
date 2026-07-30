// Guards against false positives on `thrown.ts`'s two "trivially unreachable"
// checks: a throw after an unconditional `return` in the same block, and a
// throw inside `if (false) { ... }`. Neither is producible, so neither needs
// documenting — both handlers are intentionally left with zero
// `@ApiResponse` decorators.
import { Controller, Get, NotFoundException, BadRequestException } from '@nestjs/common';

@Controller('unreachable')
export class UnreachableController {
  // The `throw` after the unconditional `return` never runs.
  @Get('after-return')
  findOne(): string {
    return 'widget';
    throw new NotFoundException('never reached');
  }

  // `if (false)` is never entered.
  @Get('if-false')
  findTwo(): string {
    if (false) {
      throw new BadRequestException('never reached');
    }
    return 'widget';
  }
}
