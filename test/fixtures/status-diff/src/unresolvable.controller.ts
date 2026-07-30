// Everything in this controller must resolve to `unknown` and therefore
// produce NO finding (PLAN §4.2's "bias: silence over noise" invariant):
//
// - A custom exception class, even one that `extends` a built-in — `extends`
//   chains are explicitly Phase 3 (PLAN §4.2 step 1), so Phase 2 must not
//   guess its status from the base class.
// - `new HttpException(msg, someVariable)` — a non-literal, non-HttpStatus
//   status argument (PLAN §4.2 step 5).
import { Controller, Get, Post, HttpException, NotFoundException } from '@nestjs/common';

class CustomNotFoundException extends NotFoundException {}

@Controller('unresolvable')
export class UnresolvableController {
  @Get(':id')
  findOne(): string {
    throw new CustomNotFoundException('custom, not built-in');
  }

  @Post()
  create(dynamicStatus: number): string {
    throw new HttpException('dynamic', dynamicStatus);
  }
}
