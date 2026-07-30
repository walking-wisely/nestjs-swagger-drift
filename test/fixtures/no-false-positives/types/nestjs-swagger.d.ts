// Minimal ambient stub for `@nestjs/swagger`, in the same
// `declare module '<name>' { ... }` shape `core/decorators.ts`'s provenance
// check recognizes (see `test/fixtures/basic/types/nestjs.d.ts`'s comment
// for the full rationale). Covers the generic decorator, the shorthand
// family Phase 2 needs to exercise, and `@ApiDefaultResponse`.
declare module '@nestjs/swagger' {
  export interface ApiResponseOptions {
    status?: number;
    description?: string;
  }

  export function ApiResponse(options?: ApiResponseOptions): MethodDecorator & ClassDecorator;
  export function ApiOkResponse(options?: ApiResponseOptions): MethodDecorator & ClassDecorator;
  export function ApiCreatedResponse(options?: ApiResponseOptions): MethodDecorator & ClassDecorator;
  export function ApiBadRequestResponse(
    options?: ApiResponseOptions,
  ): MethodDecorator & ClassDecorator;
  export function ApiUnauthorizedResponse(
    options?: ApiResponseOptions,
  ): MethodDecorator & ClassDecorator;
  export function ApiForbiddenResponse(
    options?: ApiResponseOptions,
  ): MethodDecorator & ClassDecorator;
  export function ApiNotFoundResponse(options?: ApiResponseOptions): MethodDecorator & ClassDecorator;
  export function ApiConflictResponse(options?: ApiResponseOptions): MethodDecorator & ClassDecorator;
  export function ApiUnprocessableEntityResponse(
    options?: ApiResponseOptions,
  ): MethodDecorator & ClassDecorator;
  export function ApiInternalServerErrorResponse(
    options?: ApiResponseOptions,
  ): MethodDecorator & ClassDecorator;
  export function ApiDefaultResponse(options?: ApiResponseOptions): MethodDecorator & ClassDecorator;

  export function ApiTags(...tags: string[]): ClassDecorator;
}
