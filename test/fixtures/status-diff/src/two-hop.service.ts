// Hop 1: a service with no throw of its own, but which calls a repository
// (hop 2) that does throw. Exercises `maxDepth: 2`'s "service, then
// repository" default (PLAN §4.1b).
import { Injectable } from '@nestjs/common';
import { OrgRepository } from './two-hop.repository.js';

@Injectable()
export class OrgService {
  constructor(private readonly repo: OrgRepository) {}

  create(name: string): string {
    return this.repo.save(name);
  }
}
