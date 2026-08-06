// PLAN §4.1c / `validation-pipe.ts`: the implicit 400 from a class-validator
// DTO parameter, opt-in via `AnalysisOptions.checkValidationPipe`.
import { Body, Controller, Post } from '@nestjs/common';
import { CreateUserDto, PlainDto } from './create-user.dto.js';

@Controller('validation-pipe')
export class ValidationPipeController {
  // @Body() + a class-validator-decorated DTO — implicit 400 when the check is enabled.
  @Post()
  create(@Body() dto: CreateUserDto): string {
    return dto.name;
  }

  // @Body(), but the DTO has no class-validator decorators at all — must never
  // trigger the implicit 400, regardless of whether the check is enabled.
  @Post('plain')
  createPlain(@Body() dto: PlainDto): string {
    return dto.name;
  }
}
