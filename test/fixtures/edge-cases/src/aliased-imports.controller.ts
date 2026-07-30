// Aliased imports: the *local* names don't match `'Controller'`/`'Get'` at
// all, so this only works if provenance matching keys off the checker's
// resolved (target-module) symbol name, not the name as written at the use
// site (Phase 1 review, S1).
import { Controller as Ctl, Get as HttpGet } from '@nestjs/common';

@Ctl('aliased')
export class AliasedController {
  @HttpGet(':id')
  findOne(): string {
    return 'aliased';
  }
}
