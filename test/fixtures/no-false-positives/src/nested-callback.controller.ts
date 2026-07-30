// Guards against a false positive on a throw inside a nested callback
// (`items.forEach(cb)`) — `thrown.ts`'s module doc: a throw inside a nested
// function/arrow body is deliberately NOT walked as part of the handler's
// own control flow (a detached callback's throw doesn't propagate to this
// function's own HTTP response the way a direct throw does). Currently and
// deliberately not collected, so this must produce no finding even though
// it is undocumented and would resolve cleanly as a direct throw.
import { Controller, Get, NotFoundException } from '@nestjs/common';

@Controller('nested-callback')
export class NestedCallbackController {
  @Get()
  list(): string[] {
    const ids = ['a', 'missing', 'c'];
    ids.forEach((id) => {
      if (id === 'missing') {
        throw new NotFoundException(id);
      }
    });
    return ids;
  }
}
