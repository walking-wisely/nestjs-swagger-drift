import { Controller, Get } from '@nestjs/common';

// Bare `@Controller()` — no prefix. `@Get()` here — no method path either.
// PLAN.md Phase 1 exit criterion: this must resolve to `GET /`.
@Controller()
export class HealthController {
  @Get()
  check(): string {
    return 'ok';
  }
}
