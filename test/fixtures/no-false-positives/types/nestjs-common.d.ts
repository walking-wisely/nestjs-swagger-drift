// Minimal ambient stub for `@nestjs/common`, extended for Phase 2 beyond the
// Phase 1 basic fixture's stub: the built-in HTTP exception classes,
// `HttpException`, and the `HttpStatus` enum. See
// `src/core/nest-exceptions.ts`'s module doc for why this table is
// hand-maintained rather than backed by a real `@nestjs/common` install.
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
  export function Patch(path?: PathType): MethodDecorator;
  export function Options(path?: PathType): MethodDecorator;
  export function Head(path?: PathType): MethodDecorator;
  export function All(path?: PathType): MethodDecorator;
  export function Search(path?: PathType): MethodDecorator;

  export function Injectable(): ClassDecorator;

  export enum HttpStatus {
    OK = 200,
    CREATED = 201,
    NO_CONTENT = 204,
    BAD_REQUEST = 400,
    UNAUTHORIZED = 401,
    FORBIDDEN = 403,
    NOT_FOUND = 404,
    CONFLICT = 409,
    UNPROCESSABLE_ENTITY = 422,
    INTERNAL_SERVER_ERROR = 500,
  }

  export class HttpException extends Error {
    constructor(response: string | Record<string, unknown>, status: number);
    getStatus(): number;
  }

  export class BadRequestException extends HttpException {
    constructor(message?: string);
  }
  export class UnauthorizedException extends HttpException {
    constructor(message?: string);
  }
  export class ForbiddenException extends HttpException {
    constructor(message?: string);
  }
  export class NotFoundException extends HttpException {
    constructor(message?: string);
  }
  export class ConflictException extends HttpException {
    constructor(message?: string);
  }
  export class UnprocessableEntityException extends HttpException {
    constructor(message?: string);
  }
  export class InternalServerErrorException extends HttpException {
    constructor(message?: string);
  }
  export class ServiceUnavailableException extends HttpException {
    constructor(message?: string);
  }
}
