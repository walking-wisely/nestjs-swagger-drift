// `guard-narrowing.ts` fixture: a guard whose `canActivate` branches on the
// two recognized narrowing shapes (see that module's doc comment) —
// (1) a `Reflector` metadata read gated behind a custom decorator, and
// (2) an HTTP-method membership check against the request pulled off
// `ExecutionContext`. Each branch throws a DIFFERENT, easily distinguished
// status so tests can assert exactly which one narrowing did or didn't
// exclude for a given handler.
import { ConflictException, ForbiddenException, Injectable, SetMetadata } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

export const OPT_IN_KEY = 'guard-narrowing:opt-in';
export const OptIn = (bucket: string) => SetMetadata(OPT_IN_KEY, bucket);

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

@Injectable()
export class ConditionalThrottleGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();

    // Pattern 1: decorator-metadata gate — only reachable when the analyzed
    // handler (or its class) carries `@OptIn(...)`.
    const bucket = this.reflector.getAllAndOverride<string>(OPT_IN_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (bucket) {
      throw new ForbiddenException('opted-in bucket exceeded');
    }

    // Pattern 2: HTTP-method gate — only reachable for a write method.
    if (WRITE_METHODS.has(request.method)) {
      throw new ConflictException('write-method limit exceeded');
    }

    return true;
  }
}
