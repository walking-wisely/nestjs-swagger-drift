// Hop 2 of the two-hop call-graph case: a repository called from a service,
// not from the controller directly.
import { Injectable, ConflictException } from '@nestjs/common';

@Injectable()
export class OrgRepository {
  save(name: string): string {
    if (!name) throw new ConflictException('org already exists');
    return 'saved';
  }
}
