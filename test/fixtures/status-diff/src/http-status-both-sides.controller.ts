// `HttpStatus.X` on both the thrown side (`new HttpException(msg,
// HttpStatus.CONFLICT)`, PLAN §4.2 step 3) and the documented side
// (`@ApiResponse({ status: HttpStatus.CONFLICT })`, PLAN §4.3) — must
// produce no finding.
import { Controller, Post, HttpException, HttpStatus } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';

@Controller('http-status')
export class HttpStatusBothSidesController {
  @Post()
  @ApiResponse({ status: HttpStatus.CONFLICT, description: 'conflict' })
  create(): string {
    throw new HttpException('conflict', HttpStatus.CONFLICT);
  }
}
