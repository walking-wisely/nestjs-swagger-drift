// Minimal ambient stub for `@nestjs/swagger`, extended over
// `fix-tier1`'s copy with `type`/`isArray` on `ApiResponseOptions` (what
// Tier 2's autofix emits) and `@ApiProperty`/`@ApiPropertyOptional` (§10.3's
// gate 2 -- a DTO needs at least one to be eligible for type resolution).
declare module '@nestjs/swagger' {
  export interface ApiResponseOptions {
    status?: number;
    description?: string;
    type?: unknown;
    isArray?: boolean;
  }

  export function ApiResponse(options?: ApiResponseOptions): MethodDecorator & ClassDecorator;
  export function ApiOkResponse(options?: ApiResponseOptions): MethodDecorator & ClassDecorator;
  export function ApiCreatedResponse(options?: ApiResponseOptions): MethodDecorator & ClassDecorator;
  export function ApiTags(...tags: string[]): ClassDecorator;

  export interface ApiPropertyOptions {
    description?: string;
  }
  export function ApiProperty(options?: ApiPropertyOptions): PropertyDecorator;
  export function ApiPropertyOptional(options?: ApiPropertyOptions): PropertyDecorator;
}
