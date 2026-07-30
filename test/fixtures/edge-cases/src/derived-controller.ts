import { Controller, Get } from '@nestjs/common';

// KNOWN GAP (see the comment on `getHandlersForClass` in
// src/core/handlers.ts, and PLAN.md §6 — flagged in the Phase 1 review, S2):
// `BaseController` is a common "generic CRUD base" NestJS pattern — it has
// no `@Controller` of its own, but its `@Get`/`@Post`/... handlers become
// live routes on any subclass that IS a controller, because NestJS ≥8 walks
// the whole prototype chain when registering routes.
//
// This tool's discovery only looks at a class's OWN members
// (`ClassLikeDeclaration.members`), so `GET /derived/inherited` below is a
// real, live NestJS route that this fixture's `expected.json` intentionally
// does NOT include — it documents current (incomplete) behavior, not
// correct behavior. Fixing this needs walking `heritageClauses` to the base
// class declaration (when it's in the same program), deferred out of
// Phase 1 scope.
export class BaseController {
  @Get('inherited')
  inherited(): string {
    return 'from base';
  }
}

@Controller('derived')
export class DerivedController extends BaseController {
  @Get('own')
  own(): string {
    return 'from derived';
  }
}
