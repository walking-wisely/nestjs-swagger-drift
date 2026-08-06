// Guards against a false positive when `HttpStatus` is used on BOTH sides:
// the thrown side (`new HttpException(msg, HttpStatus.CONFLICT)`, PLAN §4.2
// step 3) and the documented side (`@ApiResponse({ status:
// HttpStatus.CONFLICT })`, PLAN §4.3) — both must resolve to the same
// numeric status via `status-value.ts` and cancel out.
import { Controller, Post, HttpException, HttpStatus } from '@nestjs/common';
import { ApiResponse, ApiCreatedResponse } from '@nestjs/swagger';

@Controller('http-status-enum')
export class HttpStatusEnumController {
  @Post()
  @ApiCreatedResponse({ description: 'created' })
  @ApiResponse({ status: HttpStatus.CONFLICT, description: 'conflict' })
  create(): string {
    throw new HttpException('conflict', HttpStatus.CONFLICT);
  }
}
