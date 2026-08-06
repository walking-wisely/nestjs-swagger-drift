// `guard-narrowing.ts` fixture, edge cases (code-review round): each guard
// below isolates ONE shape that must NOT be (wrongly) narrowed, or must be
// narrowed correctly by the literal-value/nested-factory resolution paths —
// see `guard-narrowing-edge-cases.controller.ts` for the handlers exercising
// each one.
import { ConflictException, ForbiddenException, Injectable, SetMetadata, applyDecorators } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

// --- 1: a `.get(...)` call on something that is NOT a `Reflector` must
// never be mistaken for a metadata read — always reachable, never narrowed.
@Injectable()
export class MapLookupGuard implements CanActivate {
  private readonly blocked = new Map<string, boolean>([['x', true]]);
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const isBlocked = this.blocked.get(request.method);
    if (isBlocked) {
      throw new ForbiddenException('blocked');
    }
    return true;
  }
}

// --- 2: an HTTP-method gate must never narrow an `@All()` handler — its
// real semantics aren't knowable from the decorator alone.
const WRITE_METHODS_2 = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
@Injectable()
export class AllMethodGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    if (WRITE_METHODS_2.has(request.method)) {
      throw new ConflictException('write-method limit exceeded');
    }
    return true;
  }
}

// --- 3: a metadata key applied as a bare STRING LITERAL on the decorator
// side must still match the same key read via a shared const on the guard
// side (matched by resolved literal value, not only by symbol identity).
export const LITERAL_KEY = 'literal-key-example';
export const LiteralKeyDecorator = (v: string) => SetMetadata('literal-key-example', v); // literal, not the const
@Injectable()
export class LiteralKeyGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}
  canActivate(context: ExecutionContext): boolean {
    const flag = this.reflector.getAllAndOverride<string>(LITERAL_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (flag) {
      throw new ForbiddenException('literal-key gate');
    }
    return true;
  }
}

// --- 4: a decorator composed via `applyDecorators(...)` wrapping ANOTHER
// decorator factory (not `SetMetadata` directly) must still be traced.
export const NESTED_KEY = 'nested-key-example';
const InnerRole = (v: string) => SetMetadata(NESTED_KEY, v);
export const NestedRoleDecorator = () => applyDecorators(InnerRole('admin'));
@Injectable()
export class NestedFactoryGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}
  canActivate(context: ExecutionContext): boolean {
    const role = this.reflector.getAllAndOverride<string>(NESTED_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (role) {
      throw new ForbiddenException('nested-factory gate');
    }
    return true;
  }
}

// --- 5: an `||` condition must never be narrowed, even when one operand
// alone would be — `flattenAnd` deliberately only flattens `&&`.
export const OR_KEY = 'or-key-example';
@Injectable()
export class OrConditionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const flag = this.reflector.getAllAndOverride<string>(OR_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    // Neither `flag` (no matching decorator) nor a write method — but the
    // `||` means this must stay reachable regardless.
    if (flag || WRITE_METHODS_2.has(request.method)) {
      throw new ForbiddenException('or-gate');
    }
    return true;
  }
}
