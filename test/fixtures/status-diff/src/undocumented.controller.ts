// Phase 2's exit criterion: a handler that throws a built-in exception with
// no `@ApiResponse` documentation at all. Must produce exactly one
// `undocumented-status` finding for 404 and cause the CLI to exit 1.
import { Controller, Get, NotFoundException } from '@nestjs/common';

@Controller('widgets')
export class UndocumentedController {
  @Get(':id')
  findOne(): string {
    throw new NotFoundException('widget not found');
  }
}

// Not a @Controller — a throwing method here must never produce a finding,
// however handler-shaped it looks syntactically. Exercised by
// `analyzeHandler is a no-op for non-handler methods` in
// test/integration/analyze.test.ts.
export class NotAController {
  findOne(): string {
    throw new NotFoundException('not a real handler');
  }
}
