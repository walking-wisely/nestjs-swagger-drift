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
