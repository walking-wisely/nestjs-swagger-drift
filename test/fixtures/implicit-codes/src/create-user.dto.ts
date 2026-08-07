import { IsNotEmpty, IsString, MinLength } from 'class-validator';
import { applyDecorators } from '@nestjs/common';

export class CreateUserDto {
  @IsString()
  @IsNotEmpty()
  name!: string;
}

// Deliberately undecorated — a `@Body()` parameter typed as THIS class must
// never trigger the implicit-400 check (no class-validator decorators to find).
export class PlainDto {
  name!: string;
}

// Issue #13a: an array-typed `@Body()` parameter — `ValidationPipe`
// validates (and can reject) each element of `CreateItemDto[]` the same way
// it validates a single DTO.
export class CreateItemDto {
  @IsString()
  @IsNotEmpty()
  sku!: string;
}

// Issue #13b: a locally-composed decorator built with
// `applyDecorators(IsString(), MinLength(8))` — its OWN provenance resolves
// as `'mismatch'` against `class-validator` (it's declared right here, not
// in the `class-validator` package), but its body calls real
// `class-validator` decorators, so it must still count.
export function IsStrongPassword(): PropertyDecorator {
  return applyDecorators(IsString(), MinLength(8)) as unknown as PropertyDecorator;
}

export class CreateAccountDto {
  @IsStrongPassword()
  password!: string;
}
