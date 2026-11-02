declare module '@nestjs/swagger' {
  export interface ApiResponseOptions {
    status?: number;
    description?: string;
  }

  export function ApiResponse(options?: ApiResponseOptions): MethodDecorator & ClassDecorator;
  export function ApiOkResponse(options?: ApiResponseOptions): MethodDecorator & ClassDecorator;
  export function ApiCreatedResponse(options?: ApiResponseOptions): MethodDecorator & ClassDecorator;
  export function ApiNotFoundResponse(options?: ApiResponseOptions): MethodDecorator & ClassDecorator;
  export function ApiConflictResponse(options?: ApiResponseOptions): MethodDecorator & ClassDecorator;
}
