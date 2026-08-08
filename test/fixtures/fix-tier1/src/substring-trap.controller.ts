// An EXISTING @ApiResponse whose text merely CONTAINS "status: 404" — in a
// nested schema example and in free-text description — without an own
// `status: 404` property. `decoratorAlreadyPresent`'s original substring
// search over the whole argument's text falsely matched both, silently
// skipping the genuinely-needed insertion (issue 6). This controller's real
// documented status is 200, not 404: autofix must still insert
// `@ApiNotFoundResponse` for the direct throw.
import { Controller, Get, NotFoundException } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';

@Controller('substring-trap')
export class SubstringTrapController {
  @Get(':id')
  @ApiResponse({
    status: 200,
    description: 'On error this endpoint used to send { status: 404 } style bodies',
    schema: { example: { status: 404 } },
  })
  findOne(): string {
    throw new NotFoundException('widget not found');
  }
}
