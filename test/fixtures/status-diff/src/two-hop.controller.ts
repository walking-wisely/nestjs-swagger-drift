// PLAN §4.4's sample output, reproduced concretely: the 409 is only
// reachable two hops away — controller -> OrgService.create ->
// OrgRepository.save — and must still be found and attributed with a
// `via` path spelling out both hops.
import { Controller, Post } from '@nestjs/common';
import { OrgService } from './two-hop.service.js';

@Controller('orgs')
export class TwoHopController {
  constructor(private readonly orgs: OrgService) {}

  @Post()
  create(name: string): string {
    return this.orgs.create(name);
  }
}
