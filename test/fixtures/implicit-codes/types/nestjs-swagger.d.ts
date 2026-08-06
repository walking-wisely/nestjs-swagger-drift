// Ambient stub for `@nestjs/swagger` — see `status-diff`'s equivalent file's
// comment for the full rationale. Only the shorthand decorators this
// fixture's controllers actually use.
declare module '@nestjs/swagger' {
  export interface ApiResponseOptions {
    status?: number;
    description?: string;
  }

  export function ApiResponse(options?: ApiResponseOptions): MethodDecorator & ClassDecorator;
  export function ApiDefaultResponse(options?: ApiResponseOptions): MethodDecorator & ClassDecorator;
  export function ApiOkResponse(options?: ApiResponseOptions): MethodDecorator & ClassDecorator;
  export function ApiCreatedResponse(options?: ApiResponseOptions): MethodDecorator & ClassDecorator;
  export function ApiNoContentResponse(options?: ApiResponseOptions): MethodDecorator & ClassDecorator;
  export function ApiBadRequestResponse(
    options?: ApiResponseOptions,
  ): MethodDecorator & ClassDecorator;
  export function ApiUnauthorizedResponse(
    options?: ApiResponseOptions,
  ): MethodDecorator & ClassDecorator;
  export function ApiNotFoundResponse(options?: ApiResponseOptions): MethodDecorator & ClassDecorator;
}
