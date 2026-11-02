declare module '@nestjs/swagger' {
  export function ApiExcludeController(disable?: boolean): ClassDecorator;
  export function ApiExcludeEndpoint(disable?: boolean): MethodDecorator;
}
