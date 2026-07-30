import { Controller, Get } from '@nestjs/common';

// Exercises S2 from the Phase 1 review: static methods, bodyless overload
// signatures, and `#private` methods must never become routes — NestJS's
// `MetadataScanner` walks the prototype at runtime and only ever sees
// instance methods with a real implementation.
@Controller('filter')
export class FilterController {
  // Static: never registered by NestJS. Must be skipped.
  @Get('static')
  static staticHandler(): string {
    return 'static';
  }

  // Three decorated declarations of the same method name: two overload
  // signatures (no body — TS flags decorating an overload signature as an
  // error, but still parses and attaches the decorator; see this project's
  // own verification in the Phase 1 review) and one implementation (has a
  // body). Only the implementation may become a route.
  @Get('overload')
  handler(a: string): void;
  @Get('overload')
  handler(a: number): void;
  @Get('overload')
  handler(a: unknown): void {
    return;
  }

  // `#private` methods are never reachable as an HTTP handler. Must be skipped.
  @Get('private')
  #privateHandler(): string {
    return 'private';
  }

  @Get('normal')
  normalHandler(): string {
    return this.#privateHandler();
  }
}
