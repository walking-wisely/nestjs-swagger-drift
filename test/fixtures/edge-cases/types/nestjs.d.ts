// Same minimal ambient stub as test/fixtures/basic/types/nestjs.d.ts — see
// that file's comment for why an ambient `declare module` block (rather than
// a real installed package) is used here.
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
