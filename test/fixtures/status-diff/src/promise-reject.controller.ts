// Issue #9 (reviewer P-5): `return Promise.reject(...)` must reach a real
// `undocumented-status` finding end-to-end through `analyzeHandler`, not
// just resolve correctly inside `collectDirectThrows`'s own unit tests —
// this is the same rejection shape a `throw` inside an `async` handler
// produces, from the HTTP caller's perspective, so it must be documented or
// flagged exactly like one.
import { Controller, Get, NotFoundException } from '@nestjs/common';

@Controller('promise-reject')
export class PromiseRejectController {
  @Get(':id')
  findOne(): Promise<string> {
    return Promise.reject(new NotFoundException('widget not found'));
  }
}
