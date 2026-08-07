import { IsNotEmpty, IsString, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';
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

// Issue #13b regression (confirmed FP in adversarial review): a locally
// composed decorator whose body calls ONLY `class-transformer`'s
// `Transform` — never `class-validator` — must NOT count as a validation
// source. `Transform(({ value }) => value.trim())`'s callback parameter is
// typed `unknown`/`any`-ish, so `value.trim` has no resolvable symbol; the
// walk must not mistake that "unresolvable callee" for proof of validation.
export function Trim(): PropertyDecorator {
  return applyDecorators(
    Transform(({ value }) => (typeof value === 'string' ? value.trim() : value)),
  ) as unknown as PropertyDecorator;
}

export class TrimOnlyDto {
  @Trim()
  name!: string;
}

// Issue #13b2: a composed decorator assigned straight to a `const` (no
// `function` wrapper, applied bare as `@ConstComposed` not
// `@ConstComposed()`) — the other legal way to write issue #13b's pattern.
export const ConstComposed = applyDecorators(IsString(), MinLength(8)) as unknown as PropertyDecorator;

export class ConstComposedDto {
  @ConstComposed
  password!: string;
}
