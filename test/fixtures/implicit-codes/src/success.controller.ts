// PLAN §4.1c / `success.ts`: the implicit 2xx success status, on by default.
import { Controller, Get, HttpCode, Post, All, Redirect, Res, Sse } from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';

@Controller('success')
export class SuccessController {
  // No throws, no @ApiResponse of any kind — must report an undocumented 200.
  @Get()
  list(): string[] {
    return [];
  }

  // Default POST success is 201, not 200 — must report 201, not 200.
  @Post()
  create(): string {
    return 'created';
  }

  // @HttpCode overrides the method-based default — must report 204, not 200.
  @HttpCode(204)
  @Post('noop')
  noop(): void {
    return;
  }

  // Fully documented — must produce no finding at all.
  @ApiOkResponse({ status: 200 })
  @Get('documented')
  documented(): string[] {
    return [];
  }

  // Phase 5 review, finding #4: `@Redirect()` defaults to 302, not
  // 200/201 — the plain default must not be asserted, so no implicit-success
  // finding at all (silence over noise: better to under-report than assert a
  // wrong default).
  @Redirect('https://example.com')
  @Get('redirect')
  redirect(): void {
    return;
  }

  // Phase 5 review, finding #4: a `@Res()` parameter means NestJS's
  // automatic status-setting is bypassed entirely — no implicit-success
  // finding.
  @Get('raw-response')
  rawResponse(@Res() res: unknown): void {
    return;
  }

  // Phase 5 review, finding #4: `@All()` could serve GET- or POST-like
  // semantics — the plain default is a genuine guess, so no implicit-success
  // finding without an explicit `@HttpCode`.
  @All('anything')
  anything(): string {
    return 'ok';
  }

  // `@All()`, but WITH an explicit `@HttpCode` — that's a fact, not a guess,
  // so it must still be used (and therefore still reported as missing).
  @HttpCode(201)
  @All('anything-with-http-code')
  anythingWithHttpCode(): string {
    return 'ok';
  }

  // Issue #8: `@Sse()` is discovered as a GET route (`decorators.ts` maps it
  // to `HttpMethod: 'GET'`) — but must produce NO implicit-success finding,
  // same carve-out as `@Redirect()`/`@Res()` above (a streaming handler has
  // no single response to status-code).
  @Sse('events')
  events(): unknown {
    return undefined;
  }
}
