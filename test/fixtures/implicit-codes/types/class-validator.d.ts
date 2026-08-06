// Minimal ambient stub for `class-validator`, in the same shape every other
// fixture stubs its third-party modules with (see `nest-exceptions.ts`'s
// module doc). Only the two decorators `validation-pipe.controller.ts` uses.
declare module 'class-validator' {
  export function IsString(): PropertyDecorator;
  export function IsNotEmpty(): PropertyDecorator;
}
