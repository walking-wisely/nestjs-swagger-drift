// PLAN §4.1c / `validation-pipe.ts`: the implicit 400 from a class-validator
// DTO parameter, opt-in via `AnalysisOptions.checkValidationPipe`.
import { Body, Controller, Post } from '@nestjs/common';
import {
  CreateUserDto,
  PlainDto,
  CreateItemDto,
  CreateAccountDto,
  TrimOnlyDto,
  ConstComposedDto,
} from './create-user.dto.js';

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

  // Issue #13a: an ARRAY-typed `@Body()` DTO parameter — must still trigger
  // the implicit 400, same as a single-DTO parameter.
  @Post('items')
  createMany(@Body() items: CreateItemDto[]): string {
    return 'ok';
  }

  // Issue #13b: a `@Body()` DTO whose only decorated property uses a
  // LOCALLY-COMPOSED decorator (`applyDecorators(IsString(), MinLength(8))`)
  // rather than a bare `class-validator` export directly — must still
  // trigger the implicit 400.
  @Post('account')
  createAccount(@Body() dto: CreateAccountDto): string {
    return 'ok';
  }

  // Issue #13b regression: a DTO whose only decorator is a locally-composed
  // one built ONLY from `class-transformer`'s `Transform` — never a real
  // `class-validator` call — must NOT trigger the implicit 400.
  @Post('trim-only')
  createTrimOnly(@Body() dto: TrimOnlyDto): string {
    return 'ok';
  }

  // Issue #13b2: a DTO validated via a composed decorator assigned straight
  // to a `const` (`export const X = applyDecorators(...)`, applied bare as
  // `@X`) rather than wrapped in a `function` — must still trigger the
  // implicit 400.
  @Post('const-composed')
  createConstComposed(@Body() dto: ConstComposedDto): string {
    return 'ok';
  }

  // Issue #13a (adversarial review, confirmed false negative): an OPTIONAL
  // `@Body()` DTO parameter (`dto?: CreateUserDto`) — under `strict`, its
  // static type widens to `CreateUserDto | undefined`, which the pre-fix
  // unwrap logic couldn't see through — must still trigger the implicit 400.
  @Post('optional')
  createOptional(@Body() dto?: CreateUserDto): string {
    return 'ok';
  }

  // Issue #13a (adversarial review, confirmed false negative): the FIXED
  // array case, made optional (`items?: CreateItemDto[]`) — the exact shape
  // called out as still-broken after the first-round array-only fix.
  @Post('optional-items')
  createOptionalItems(@Body() items?: CreateItemDto[]): string {
    return 'ok';
  }

  // Issue #13a (adversarial review, confirmed false negative): a NULLABLE
  // `@Body()` DTO parameter (`dto: CreateUserDto | null`).
  @Post('nullable')
  createNullable(@Body() dto: CreateUserDto | null): string {
    return 'ok';
  }

  // Issue #13a (adversarial review): a NESTED array (`CreateItemDto[][]`).
  @Post('nested-items')
  createNestedItems(@Body() items: CreateItemDto[][]): string {
    return 'ok';
  }
}
