// A rethrow (`throw <identifier>`) where the identifier's declared type is a
// known built-in exception, resolved via the checker rather than a `catch`
// special-case (PLAN §4.1a) — see `resolve-status.ts`'s module doc for why a
// real `catch (err)` variable can't be typed this specifically. Undocumented
// here, so this must produce a 404 finding.
import { Controller, Get, NotFoundException } from '@nestjs/common';

@Controller('rethrow')
export class RethrowController {
  @Get(':id')
  findOne(): string {
    const notFound = new NotFoundException('not found');
    throw notFound;
  }
}
