import { Injectable, UnauthorizedException } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';

// #11: the common Passport `AuthGuard('jwt')` mixin pattern — a factory
// function that returns a class rather than naming one directly. Exercises
// `heritage.ts`'s type-based fallback (`resolveClassDeclaration`) through
// `guards.ts`'s `resolveGuardClassExpression`.
class AuthGuardBase implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (!context) throw new UnauthorizedException('missing token');
    return true;
  }
}

export function AuthGuard(_strategy: string) {
  class MixinAuthGuard extends AuthGuardBase {}
  return MixinAuthGuard;
}

// A `const` holding the mixin call's result, the exact shape
// `@nestjs/passport` users assign at module scope.
export const AuthGuardJwt = AuthGuard('jwt');
