// PLAN §4.1c / `guards.ts`: the implicit 401/403 from `@UseGuards(...)`,
// opt-in via `AnalysisOptions.checkGuards`.
import { Controller, Get, UseGuards } from '@nestjs/common';
import { AuthGuard, DerivedGuard } from './auth.guard.js';

@Controller('guarded')
export class GuardsController {
  // AuthGuard.canActivate throws UnauthorizedException directly — implicit
  // 401 when the check is enabled.
  @UseGuards(AuthGuard)
  @Get()
  list(): string[] {
    return [];
  }

  // DerivedGuard has no canActivate of its own; the check must walk up to
  // BaseGuard's — implicit 401 when the check is enabled.
  @UseGuards(DerivedGuard)
  @Get('derived')
  derived(): string[] {
    return [];
  }
}

// CodeRabbit review on PR #4: NestJS applies class-level and method-level
// `@UseGuards(...)` additively (both run), so re-stating a guard already
// applied at the class level is valid, if redundant, code — a common
// pattern for readability. `collectGuardStatuses` must resolve that guard's
// `canActivate` once, not once per place it's listed, or the same 401
// source appears twice in a single finding.
@Controller('guarded-redundant')
@UseGuards(AuthGuard)
export class RedundantGuardController {
  @UseGuards(AuthGuard)
  @Get()
  list(): string[] {
    return [];
  }
}
