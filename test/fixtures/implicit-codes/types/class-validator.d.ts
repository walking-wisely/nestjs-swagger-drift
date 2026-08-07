// Minimal ambient stub for `class-validator`, in the same shape every other
// fixture stubs its third-party modules with (see `nest-exceptions.ts`'s
// module doc). `MinLength` added for issue #13b's locally-composed-decorator
// fixture (`applyDecorators(IsString(), MinLength(8))`).
declare module 'class-validator' {
  export function IsString(): PropertyDecorator;
  export function IsNotEmpty(): PropertyDecorator;
  export function MinLength(min: number): PropertyDecorator;
}

// Minimal ambient stub for `class-transformer`, used by the issue #13b
// false-positive regression fixture (`@Trim()` composed purely from
// `Transform`, never touching `class-validator`).
declare module 'class-transformer' {
  export function Transform(fn: (params: { value: unknown }) => unknown): PropertyDecorator;
}
