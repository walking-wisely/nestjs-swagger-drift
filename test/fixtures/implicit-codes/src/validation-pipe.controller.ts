// PLAN §4.1c / `validation-pipe.ts`: the implicit 400 from a class-validator
// DTO parameter, opt-in via `AnalysisOptions.checkValidationPipe`.
import { Body, Controller, Post } from '@nestjs/common';
import { CreateUserDto, PlainDto } from './create-user.dto.js';

@Controller('validation-pipe')
export class ValidationPipeController {
  // @Body() + a class-validator-decorated DTO — implicit 400 when the check is enabled.
  @Post()
  create(@Body() dto: CreateUserDto): string {
    // Returns a fixed string, not `dto.*`: only the parameter's decorators
    // and type matter to what's under test here (implicit-400 detection);
    // echoing request-derived input back verbatim tripped CodeQL's generic
    // reflected-XSS heuristic on this never-served, AST-only test fixture.
    return 'ok';
  }

  // @Body(), but the DTO has no class-validator decorators at all — must never
  // trigger the implicit 400, regardless of whether the check is enabled.
  @Post('plain')
  createPlain(@Body() dto: PlainDto): string {
    // Returns a fixed string, not `dto.*`: only the parameter's decorators
    // and type matter to what's under test here (implicit-400 detection);
    // echoing request-derived input back verbatim tripped CodeQL's generic
    // reflected-XSS heuristic on this never-served, AST-only test fixture.
    return 'ok';
  }
}
