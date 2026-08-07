// Minimal ambient stub for `class-validator`, in the same shape every other
// fixture stubs its third-party modules with (see `nest-exceptions.ts`'s
// module doc). `MinLength` added for issue #13b's locally-composed-decorator
// fixture (`applyDecorators(IsString(), MinLength(8))`).
declare module 'class-validator' {
  export function IsString(): PropertyDecorator;
  export function IsNotEmpty(): PropertyDecorator;
  export function MinLength(min: number): PropertyDecorator;
}
