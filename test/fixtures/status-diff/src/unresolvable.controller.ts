// Everything in this controller must resolve to `unknown` and therefore
// produce NO finding (PLAN §4.2's "bias: silence over noise" invariant):
//
// - `new HttpException(msg, someVariable)` — a non-literal, non-HttpStatus
//   status argument (PLAN §4.2 step 5).
//
// Custom exception classes that DO resolve (extends chains, `super(msg,
// 409)`, ...) moved to `custom-exception.controller.ts` once Phase 3
// implemented them — this file is now specifically the "genuinely can't be
// resolved" corpus.
import { Controller, Post, HttpException } from '@nestjs/common';

@Controller('unresolvable')
export class UnresolvableController {
  @Post()
  create(dynamicStatus: number): string {
    throw new HttpException('dynamic', dynamicStatus);
  }
}
