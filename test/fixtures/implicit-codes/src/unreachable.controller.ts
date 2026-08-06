// PLAN §5's `documented-but-unreachable` rule (opt-in): a copy-pasted
// decorator block claiming a status nothing in this handler can produce.
import { Controller, Get, HttpCode, UseGuards } from '@nestjs/common';
import { ApiNotFoundResponse, ApiOkResponse, ApiResponse, ApiForbiddenResponse } from '@nestjs/swagger';
import { SilentRejectGuard } from './auth.guard.js';

function unknownAtRuntime(): number {
  return Date.now() % 2 === 0 ? 200 : 204;
}

@Controller('unreachable')
export class UnreachableController {
  // Documents 404, but never throws anything — must be flagged when the
  // rule is enabled, and never flagged when it's off (the default).
  @ApiOkResponse({ status: 200 })
  @ApiNotFoundResponse()
  @Get()
  list(): string[] {
    return [];
  }

  // Phase 5 review, finding #1: `@HttpCode(...)`'s argument isn't a literal,
  // so `resolveSuccessStatus` can't pin down the handler's real success
  // status — the documented 200 must NOT be flagged as unreachable even
  // though nothing in `byStatus` proves it reachable this run (the tool
  // structurally cannot know, so per "silence over noise" it must not guess).
  @ApiOkResponse({ status: 200 })
  @HttpCode(unknownAtRuntime())
  @Get('dynamic-http-code')
  dynamicHttpCode(): string {
    return 'ok';
  }

  // Phase 5 review, finding #5: `SilentRejectGuard.canActivate` returns
  // `false` without throwing — undetectable by `checkGuards` regardless of
  // whether it's enabled, so the documented 403 here must stay exempt from
  // `documented-but-unreachable` either way.
  @UseGuards(SilentRejectGuard)
  @ApiForbiddenResponse()
  @Get('silent-guard')
  silentGuard(): string[] {
    return [];
  }
}

// Phase 5 review, finding #2: a class-level `@ApiResponse({ status: 500 })`
// is a common "this whole controller might 500" blanket statement, not a
// per-handler claim — and `500` specifically is structurally out of scope
// for this tool (PLAN §6: third-party-library throws Nest maps to 500).
// Neither should ever be flagged `documented-but-unreachable`.
@Controller('unreachable-class-level')
@ApiResponse({ status: 500, description: 'unexpected error, mapped by Nest' })
export class ClassLevel500Controller {
  @ApiOkResponse({ status: 200 })
  @Get()
  list(): string[] {
    return [];
  }

  // A method-level 500 (not just class-level) must ALSO be exempt — the
  // "structurally out of scope" reasoning is about the status, not about
  // where it's documented.
  @ApiOkResponse({ status: 200 })
  @ApiResponse({ status: 500, description: 'unexpected error' })
  @Get('method-level')
  methodLevel(): string[] {
    return [];
  }
}
