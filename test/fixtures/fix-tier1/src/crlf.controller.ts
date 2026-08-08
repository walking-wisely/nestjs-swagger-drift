// CRLF-terminated fixture (PR #21 review, Issue 8) -- every line here
// ends with a real CRLF; autofix must not introduce bare LF lines into it.
import { Controller, Get, NotFoundException } from '@nestjs/common';

@Controller('crlf-widgets')
export class CrlfController {
  @Get(':id')
  findOne(): string {
    throw new NotFoundException('widget not found');
  }
}
