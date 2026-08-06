// `guard-narrowing.ts` fixture (see `guard-narrowing.guard.ts`'s module
// comment): four handlers, one per combination of "carries `@OptIn(...)`"
// and "is a write method" — every combination exercises a different mix of
// the two branches `ConditionalThrottleGuard.canActivate` can produce.
import { Controller, Get, Patch, Post, UseGuards } from '@nestjs/common';
import { ConditionalThrottleGuard, OptIn } from './guard-narrowing.guard.js';

@Controller('guard-narrowing')
@UseGuards(ConditionalThrottleGuard)
export class GuardNarrowingController {
  // No `@OptIn(...)`, not a write method: BOTH branches are dead for this
  // handler — the guard can never throw 403 or 409 here.
  @Get()
  noOptInRead(): string[] {
    return [];
  }

  // `@OptIn(...)` present AND a write method: BOTH branches are live.
  @Post()
  @OptIn('bucket')
  optInWrite(): string {
    return 'created';
  }

  // No `@OptIn(...)`, but IS a write method: only the HTTP-method branch (409) is live.
  @Patch()
  noOptInWrite(): string {
    return 'patched';
  }

  // `@OptIn(...)` present, but NOT a write method: only the metadata branch (403) is live.
  @Get('opted')
  @OptIn('bucket')
  optInRead(): string[] {
    return [];
  }
}
