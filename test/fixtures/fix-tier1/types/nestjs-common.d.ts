// Minimal ambient stub for `@nestjs/common` — see
// `test/fixtures/status-diff/types/nestjs-common.d.ts` for the full
// rationale. Extended with `@HttpCode` (unused by this fixture directly,
// kept for parity) and enough exceptions/status values to exercise Tier 1
// autofix's shorthand vs. generic `@ApiResponse` branches.
declare module '@nestjs/common' {
  export type PathType = string | string[];

  export interface ControllerOptions {
    path?: PathType;
  }

  export function Controller(prefix?: PathType | ControllerOptions): ClassDecorator;

  export function Get(path?: PathType): MethodDecorator;
  export function Post(path?: PathType): MethodDecorator;
  export function Put(path?: PathType): MethodDecorator;
  export function Delete(path?: PathType): MethodDecorator;

  export function Injectable(): ClassDecorator;

  export enum HttpStatus {
    OK = 200,
    CREATED = 201,
    BAD_REQUEST = 400,
    NOT_FOUND = 404,
    CONFLICT = 409,
    INTERNAL_SERVER_ERROR = 500,
  }

  export class HttpException extends Error {
    constructor(response: string | Record<string, unknown>, status: number);
    getStatus(): number;
  }

  export class NotFoundException extends HttpException {
    constructor(message?: string);
  }
  export class ConflictException extends HttpException {
    constructor(message?: string);
  }
}
