// A custom exception's status (431 — not an `HttpStatus` enum member) has no
// shorthand `@Api*Response` decorator, so autofix must fall back to generic
// `@ApiResponse({ status: 431, ... })`.
import { Controller, Get, HttpException } from '@nestjs/common';

class TooManyHeadersException extends HttpException {
  constructor() {
    super('too many headers', 431);
  }
}

@Controller('custom-status')
export class CustomStatusController {
  @Get()
  list(): string[] {
    throw new TooManyHeadersException();
  }
}
