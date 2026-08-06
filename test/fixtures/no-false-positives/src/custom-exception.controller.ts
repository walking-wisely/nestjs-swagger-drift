// PLAN §4.2 custom exception status resolution (Phase 3) — the regression
// net for the "unresolvable status must never manufacture a finding" and
// "a resolved custom-exception status that IS documented must not manufacture
// a finding either" invariants.
import { Controller, Get, Post, Put, Patch, HttpException, NotFoundException } from '@nestjs/common';
import { ApiNotFoundResponse, ApiResponse, ApiOkResponse, ApiCreatedResponse } from '@nestjs/swagger';

// --- Resolvable AND correctly documented: must produce no finding. ---

// Extends chain (PLAN §4.2 step 1), one hop, no own constructor.
class DocumentedCustomNotFound extends NotFoundException {}

// extends HttpException directly with an explicit numeric literal status
// (PLAN §4.2 step 2).
class DocumentedConflict extends HttpException {
  constructor() {
    super('conflict', 409);
  }
}

// A multi-level extends chain (A extends B extends NotFoundException) — the
// "walk the WHOLE chain" requirement, still correctly documented.
class IntermediateNotFound extends NotFoundException {}
class DeepCustomNotFound extends IntermediateNotFound {}

// --- Genuinely unresolvable: must produce no finding regardless of documentation. ---

// A class extending something that merely LOOKS like a Nest exception by
// name — a same-named local class, not checker-verified against
// `@nestjs/common` — must never resolve.
class NotFoundException2 {
  constructor(public message?: string) {}
}
class LooksLikeNotFound extends NotFoundException2 {}

// A status computed dynamically at the `super(...)` call site.
class DynamicStatusException extends HttpException {
  constructor(cond: boolean) {
    super('dynamic', cond ? 400 : 409);
  }
}

// `super(...args)` spread forwarding — the status is genuinely unknown
// statically even though it happens to be a literal at every call site.
class SpreadForwardingException extends HttpException {
  constructor(...args: [string, number]) {
    super(...args);
  }
}

@Controller('custom-exception')
export class CustomExceptionController {
  @Get('resolved-documented-1')
  @ApiOkResponse({ description: 'widget' })
  @ApiNotFoundResponse({ description: 'not found' })
  findOne(): string {
    throw new DocumentedCustomNotFound('not found');
  }

  @Post('resolved-documented-2')
  @ApiCreatedResponse({ description: 'created' })
  @ApiResponse({ status: 409, description: 'conflict' })
  create(): string {
    throw new DocumentedConflict();
  }

  @Put('resolved-documented-3')
  @ApiOkResponse({ description: 'widget' })
  @ApiNotFoundResponse({ description: 'not found, via a deeper extends chain' })
  update(): string {
    throw new DeepCustomNotFound('not found');
  }

  // Only success is documented on the remaining handlers — a real
  // `checkSuccessResponse` regression net alongside the "unresolvable status
  // never manufactures a finding regardless of documentation" one: if the
  // tool ever "resolved" one of the unresolvable statuses below, it would
  // report an undocumented finding for it here. It must not.

  @Get('unresolvable-1')
  @ApiOkResponse({ description: 'widget' })
  lookAlike(): string {
    throw new LooksLikeNotFound('not the real thing');
  }

  @Post('unresolvable-2')
  @ApiCreatedResponse({ description: 'created' })
  dynamic(cond: boolean): string {
    throw new DynamicStatusException(cond);
  }

  @Patch('unresolvable-3')
  @ApiOkResponse({ description: 'widget' })
  spread(): string {
    throw new SpreadForwardingException('x', 409);
  }
}
