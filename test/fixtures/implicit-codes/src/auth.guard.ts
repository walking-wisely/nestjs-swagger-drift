import { Injectable, UnauthorizedException } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';

@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (!context) throw new UnauthorizedException('missing token');
    return true;
  }
}

// A guard reached only through a base class — exercises `guards.ts`'s
// (bounded) ancestor walk for `canActivate`.
@Injectable()
export class BaseGuard implements CanActivate {
  canActivate(): boolean {
    throw new UnauthorizedException('base guard always rejects');
  }
}

@Injectable()
export class DerivedGuard extends BaseGuard {}

// Phase 5 review, finding #5: `canActivate` returning `false` WITHOUT
// throwing — NestJS still turns this into a 403, but `checkGuards`'s own
// traversal (which only ever collects THROWN statuses) structurally cannot
// see it, on or off.
@Injectable()
export class SilentRejectGuard implements CanActivate {
  canActivate(): boolean {
    return false;
  }
}
