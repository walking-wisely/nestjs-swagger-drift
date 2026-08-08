// Minimal ambient stub for `@nestjs/swagger` — see
// `test/fixtures/status-diff/types/nestjs-swagger.d.ts` for the full
// rationale. `ApiTags` is included so `existing-import.controller.ts` can
// exercise "add a named import to an ALREADY-imported `@nestjs/swagger`
// declaration" rather than only "create a fresh import".
declare module '@nestjs/swagger' {
  export interface ApiResponseOptions {
    status?: number;
    description?: string;
    // Present only so `substring-trap.controller.ts` can put a nested
    // `{ status: <n> }` shape inside `schema` — exercising the
    // substring-match trap `decoratorAlreadyPresent` used to fall into
    // (issue 6) — without a strict-mode type error.
    schema?: { example?: unknown };
  }

  export function ApiResponse(options?: ApiResponseOptions): MethodDecorator & ClassDecorator;
  export function ApiOkResponse(options?: ApiResponseOptions): MethodDecorator & ClassDecorator;
  export function ApiCreatedResponse(options?: ApiResponseOptions): MethodDecorator & ClassDecorator;
  export function ApiNotFoundResponse(options?: ApiResponseOptions): MethodDecorator & ClassDecorator;
  export function ApiConflictResponse(options?: ApiResponseOptions): MethodDecorator & ClassDecorator;
  export function ApiTags(...tags: string[]): ClassDecorator;
}
