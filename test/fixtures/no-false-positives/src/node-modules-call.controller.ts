// PLAN §4.1b / §6: a call into a third-party (`node_modules`-shaped)
// dependency's method must never be traversed — there is no method body to
// walk in the first place (every real npm package ships only a `.d.ts`
// signature, modeled here by `third-party-orm.d.ts`'s ambient stub), so this
// must produce no finding regardless of what the real library might do at
// runtime.
import { Controller, Get } from '@nestjs/common';
import { Repository } from 'third-party-orm';

@Controller('third-party')
export class NodeModulesCallController {
  private readonly repo = new Repository();

  @Get(':id')
  findOne(id: string): string {
    return this.repo.findOne(id);
  }
}
