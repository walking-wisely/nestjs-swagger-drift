// Minimal ambient stub for `@nestjs/common` — same shape as
// `status-diff/types/nestjs-common.d.ts`, trimmed to what this fixture
// exercises.
declare module '@nestjs/common' {
  export type PathType = string | string[];

  export interface ControllerOptions {
    path?: PathType;
  }

  export function Controller(prefix?: PathType | ControllerOptions): ClassDecorator;
  export function Get(path?: PathType): MethodDecorator;
  export function Injectable(): ClassDecorator;

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
