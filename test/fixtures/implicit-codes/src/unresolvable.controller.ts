// PLAN §5's `unresolvable-status` rule (opt-in): a direct throw whose status
// can't be statically resolved, surfaced instead of silently dropped.
import { Controller, Get, HttpCode, Post, HttpException, Injectable, Res } from '@nestjs/common';
import { ApiDefaultResponse } from '@nestjs/swagger';

// Issue #15: an imported `const` whose type widens to plain `number` — not a
// literal the checker can resolve `@HttpCode(...)`'s argument to.
export const DYNAMIC_STATUS: number = 250;

@Injectable()
export class FlakyService {
  // Phase 5 review, finding #6: an unresolvable throw reached through the
  // call graph (not the handler's own direct throw) — must also surface via
  // `unresolvable-status` when enabled, not just direct handler throws.
  check(id: string): string {
    const dynamicStatus = id.length; // deliberately not a literal
    if (!id) throw new HttpException('bad id', dynamicStatus);
    return 'ok';
  }
}

@Controller('unresolvable')
export class UnresolvableController {
  @Get(':id')
  findOne(id: string): string {
    const dynamicStatus = id.length; // deliberately not a literal
    if (!id) throw new HttpException('bad id', dynamicStatus);
    return 'ok';
  }

  constructor(private readonly flaky: FlakyService) {}

  // Phase 5 review, finding #6: the unresolvable status lives in
  // `FlakyService.check`, one call-graph hop away, not in this method's own
  // body at all.
  @Get('via-service/:id')
  viaService(id: string): string {
    return this.flaky.check(id);
  }

  // Phase 5 review, finding #7: two HTTP decorators on the SAME method body
  // — the underlying unresolved throw is one physical fact about this
  // method, so it must be reported once, not once per decorator.
  @Get('multi-decorator/:id')
  @Post('multi-decorator/:id')
  multiDecorator(id: string): string {
    const dynamicStatus = id.length; // deliberately not a literal
    if (!id) throw new HttpException('bad id', dynamicStatus);
    return 'ok';
  }

  // Phase 5 review, finding #8: an `@ApiDefaultResponse` wildcard must not
  // suppress `unresolvable-status` — a wildcard's ambiguity is about what's
  // DOCUMENTED, unrelated to whether a throw's status could be resolved.
  @ApiDefaultResponse({ description: 'anything else' })
  @Get('wildcard/:id')
  wildcard(id: string): string {
    const dynamicStatus = id.length; // deliberately not a literal
    if (!id) throw new HttpException('bad id', dynamicStatus);
    return 'ok';
  }

  // Issue #15: a dynamically-valued `@HttpCode(...)` argument — previously
  // produced ZERO findings under any flag (`resolveSuccessStatus` correctly
  // declines to guess, but nothing surfaced that refusal). With
  // `unresolvable-status` enabled, this must now report an "unresolvable
  // success status" finding.
  @HttpCode(DYNAMIC_STATUS)
  @Post('dynamic-http-code')
  dynamicHttpCode(): string {
    return 'ok';
  }

  // Adversarial review: `@HttpCode` on a handler that takes the raw response
  // object (`@Res()`) is already a known carve-out — NestJS's automatic
  // status-setting (which `@HttpCode` configures) doesn't apply at all once
  // the handler owns the response directly, so this `@HttpCode`'s dynamic
  // argument is inert, not "unresolvable."
  @HttpCode(DYNAMIC_STATUS)
  @Post('dynamic-http-code-res')
  dynamicHttpCodeWithRes(@Res() res: unknown): string {
    return 'ok';
  }
}
