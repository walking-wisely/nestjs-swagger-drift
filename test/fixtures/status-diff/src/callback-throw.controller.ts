// A throw inside a callback passed to another function does not propagate
// to the handler's HTTP response the way a direct throw does (see
// `thrown.ts`'s module doc) — this must produce NO finding, even though the
// exception is undocumented and would resolve cleanly if it were a direct
// throw.
import { Controller, Get, NotFoundException } from '@nestjs/common';

@Controller('callback-throw')
export class CallbackThrowController {
  @Get()
  list(): string[] {
    const ids = ['a', 'b'];
    ids.forEach((id) => {
      if (id === 'missing') {
        throw new NotFoundException(id);
      }
    });
    return ids;
  }
}
