import { IsNotEmpty, IsString } from 'class-validator';

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
