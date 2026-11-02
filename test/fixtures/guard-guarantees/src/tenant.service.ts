import { UnauthorizedException } from '@nestjs/common';
import { RequestContext } from './request-context.js';

export class TenantService {
  list(): string[] {
    const tenantId = RequestContext.currentTenantId();
    if (!tenantId) {
      throw new UnauthorizedException('no tenant');
    }
    return [tenantId];
  }
}
