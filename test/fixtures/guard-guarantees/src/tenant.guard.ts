import { CanActivate } from '@nestjs/common';
import { RequestContext } from './request-context.js';

export class TenantGuard implements CanActivate {
  canActivate(): boolean {
    return RequestContext.currentTenantId() !== null;
  }
}
