// Phase 5 review, finding #9: a LOCAL decorator that merely shares the name
// `HttpCode` — NOT imported from `@nestjs/common` — must not be mistaken for
// the real thing by `success.ts`'s `@HttpCode` lookup (the same
// provenance-check posture `guards.ts`/`validation-pipe.ts` already apply).
// If this local decorator were wrongly accepted, its (non-numeric, and
// unresolvable to a status either way) argument would make
// `resolveSuccessStatus` return `undefined` — silently hiding what should be
// a genuine undocumented-200 finding.
import { Controller, Get } from '@nestjs/common';

function HttpCode(_label: string): MethodDecorator {
  return () => undefined;
}

@Controller('success-shadowed')
export class SuccessShadowedController {
  // No real `@HttpCode` here — just a same-named local function decorator.
  // The real `GET` default (200) must still apply.
  @HttpCode('not-a-status')
  @Get()
  list(): string[] {
    return [];
  }
}
