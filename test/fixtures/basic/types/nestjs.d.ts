// Minimal ambient stub for `@nestjs/common`, since this fixture deliberately
// does not have the real package installed (test/fixtures/** is analysis
// input, not source — see the top-level task brief / PLAN.md).
//
// Using an ambient `declare module '@nestjs/common' { ... }` block (rather
// than a real package under node_modules) is intentional: it's the shape
// `src/core/decorators.ts`'s provenance check recognizes as "this decorator
// really is from @nestjs/common", so this fixture exercises the same
// checker-based verification path a real installed package would.
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
}
