// Phase 4: `// swagger-drift-disable-next-line` suppression. The 404 here
// would otherwise be an undocumented-status finding exactly like
// `undocumented.controller.ts`'s — the directive must suppress ONLY it,
// leaving the sibling 409 (undirected, no comment) reported normally. That
// asymmetry is what makes this fixture non-vacuous: a bug that suppressed
// everything, or nothing, would still pass a test that only checked one of
// the two statuses.
import { Controller, Get, ConflictException, NotFoundException } from '@nestjs/common';

@Controller('suppressed')
export class SuppressedController {
  @Get(':id')
  findOne(id: string): string {
    if (id === 'conflict') {
      throw new ConflictException('already exists');
    }
    // swagger-drift-disable-next-line 404
    throw new NotFoundException('widget not found');
  }
}
