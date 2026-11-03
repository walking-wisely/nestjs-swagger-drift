// Ambient stub for `@nestjs/common`, extended for Phase 5 (PLAN §4.1c)
// beyond `status-diff`'s: `HttpCode`, `UseGuards`, `CanActivate`/
// `ExecutionContext`, and the `@Body`/`@Param`/`@Query` parameter decorators
// the `ValidationPipe` check looks for. See `nest-exceptions.ts`'s module
// doc for why this table is hand-maintained rather than a real install.
declare module '@nestjs/common' {
  export type PathType = string | string[];

  export function Controller(prefix?: PathType): ClassDecorator;
  export function Get(path?: PathType): MethodDecorator;
  export function Post(path?: PathType): MethodDecorator;
  export function Put(path?: PathType): MethodDecorator;
  export function Delete(path?: PathType): MethodDecorator;
  export function Patch(path?: PathType): MethodDecorator;
  export function All(path?: PathType): MethodDecorator;
  export function Sse(path?: PathType): MethodDecorator;

  export function Injectable(): ClassDecorator;

  export function HttpCode(statusCode: number): MethodDecorator;
  export function UseGuards(...guards: unknown[]): MethodDecorator & ClassDecorator;
  export function Redirect(url?: string, statusCode?: number): MethodDecorator;
  export function SetMetadata(key: string, value: unknown): MethodDecorator & ClassDecorator;
  export function applyDecorators(
    ...decorators: Array<MethodDecorator | ClassDecorator>
  ): MethodDecorator & ClassDecorator;

  export function Body(...args: unknown[]): ParameterDecorator;
  export function Param(...args: unknown[]): ParameterDecorator;
  export function Query(...args: unknown[]): ParameterDecorator;
  export function Res(): ParameterDecorator;
  export function Response(): ParameterDecorator;
  // Issue #17 (adversarial review): the parse-pipe host set widened beyond
  // Body/Param/Query — see `parse-pipes.ts`'s module doc.
  export function Headers(...args: unknown[]): ParameterDecorator;
  export function UploadedFile(...args: unknown[]): ParameterDecorator;
  export function UploadedFiles(...args: unknown[]): ParameterDecorator;

  // Issue #17: NestJS's built-in transformation pipes. Each accepts an
  // options object whose `errorHttpStatusCode` overrides the status thrown
  // on a coercion failure (adversarial review — `parse-pipes.ts` resolves it).
  // `exceptionFactory` added for the adversarial-review regression test: a
  // pipe options object naming a factory must NOT be read for
  // `errorHttpStatusCode` (real NestJS precedence is `exceptionFactory ??
  // HttpErrorByCode[errorHttpStatusCode]` — the factory always wins).
  export interface ParsePipeOptions {
    errorHttpStatusCode?: number;
    exceptionFactory?: (error: string) => unknown;
  }
  export class ParseIntPipe {
    constructor(options?: ParsePipeOptions);
  }
  export class ParseUUIDPipe {
    constructor(options?: ParsePipeOptions);
  }
  export class ParseBoolPipe {
    constructor(options?: ParsePipeOptions);
  }
  export class ParseEnumPipe {
    constructor(theEnum: unknown, options?: ParsePipeOptions);
  }
  export class ParseFloatPipe {
    constructor(options?: ParsePipeOptions);
  }
  export class ParseArrayPipe {
    constructor(options?: ParsePipeOptions);
  }
  export class ParseFilePipe {
    constructor(options?: ParsePipeOptions);
  }
  // Issue #17 (adversarial review): was missing from `BUILTIN_PARSE_PIPE_NAMES`.
  export class ParseDatePipe {
    constructor(options?: ParsePipeOptions);
  }

  export interface MinimalRequest {
    method: string;
  }
  export interface HttpArgumentsHost {
    getRequest<T = MinimalRequest>(): T;
  }
  export interface ExecutionContext {
    switchToHttp(): HttpArgumentsHost;
    getHandler(): unknown;
    getClass(): unknown;
  }
  export interface CanActivate {
    canActivate(context: ExecutionContext): boolean | Promise<boolean>;
  }

  export enum HttpStatus {
    OK = 200,
    CREATED = 201,
    NO_CONTENT = 204,
    BAD_REQUEST = 400,
    UNAUTHORIZED = 401,
    FORBIDDEN = 403,
    NOT_FOUND = 404,
    NOT_ACCEPTABLE = 406,
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
}
