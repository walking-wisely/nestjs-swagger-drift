// Ambient stub for `@nestjs/core`, added for the guard-narrowing fixtures
// (`guard-narrowing.controller.ts`) — only the one export they need.
declare module '@nestjs/core' {
  export class Reflector {
    get<T = unknown>(key: string, target: unknown): T | undefined;
    getAllAndOverride<T = unknown>(key: string, targets: unknown[]): T | undefined;
  }
}
