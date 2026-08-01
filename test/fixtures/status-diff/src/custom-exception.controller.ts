// PLAN §4.2 custom exception status resolution (Phase 3): app-local
// exception classes that DO resolve to a concrete status via the strategy
// ladder, and therefore must surface as `undocumented-status` findings when
// nothing documents them — the positive counterpart to
// `unresolvable.controller.ts`.
import { Controller, Get, Post, HttpException, NotFoundException } from '@nestjs/common';

// PLAN §4.2 step 1: extends a built-in exception directly, no own
// constructor at all — inherits the built-in's fixed status by walking the
// (one-hop) `extends` chain.
class CustomNotFoundException extends NotFoundException {}

// PLAN §4.2 step 2: extends `HttpException` itself, with an explicit numeric
// literal passed as the `super(...)` status argument.
class ConflictingUpdateException extends HttpException {
  constructor() {
    super('the resource changed underneath you', 409);
  }
}

@Controller('custom-exception')
export class CustomExceptionController {
  @Get(':id')
  findOne(): string {
    throw new CustomNotFoundException('custom, not built-in, still 404');
  }

  @Post()
  update(): string {
    throw new ConflictingUpdateException();
  }
}
