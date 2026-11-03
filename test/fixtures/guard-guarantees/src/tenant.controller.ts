import { Controller, Get, UseGuards } from '@nestjs/common';
import { TenantGuard } from './tenant.guard.js';
import { TenantService } from './tenant.service.js';

@Controller('guarded')
@UseGuards(TenantGuard)
export class GuardedController {
  constructor(private readonly service: TenantService) {}

  @Get()
  list(): string[] {
    return this.service.list();
  }
}

@Controller('open')
export class OpenController {
  constructor(private readonly service: TenantService) {}

  @Get()
  list(): string[] {
    return this.service.list();
  }
}
