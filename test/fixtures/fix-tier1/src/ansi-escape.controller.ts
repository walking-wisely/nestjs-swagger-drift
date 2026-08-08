// Contains a raw ESC byte (0x1B) inside a string literal (PR #21 review,
// Issue 9) -- --fix-dry-run must never echo it verbatim to the terminal.
import { Controller, Get, NotFoundException } from '@nestjs/common';

const ANSI_RED = '[31m';

@Controller('ansi-widgets')
export class AnsiEscapeController {
  @Get(':id')
  findOne(): string {
    console.log(ANSI_RED);
    throw new NotFoundException('widget not found');
  }
}
