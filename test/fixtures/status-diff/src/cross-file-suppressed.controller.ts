// Phase 4 review, finding S6 — see `cross-file-suppressed.service.ts`'s
// module doc. The 404 this controller's call graph resolves into is
// suppressed by a directive that lives entirely in the service's own file;
// the sibling 409, undirected, must still be reported — same asymmetry
// `suppressed.controller.ts` uses for the single-file case, proving a bug
// that suppressed everything (or nothing) reachable through the call graph
// wouldn't pass this fixture either.
import { Controller, Get } from '@nestjs/common';
import { CrossFileSuppressedService } from './cross-file-suppressed.service.js';

@Controller('cross-file-suppressed')
export class CrossFileSuppressedController {
  constructor(private readonly svc: CrossFileSuppressedService) {}

  @Get(':id')
  findOne(id: string): string {
    return this.svc.findOne(id);
  }
}
