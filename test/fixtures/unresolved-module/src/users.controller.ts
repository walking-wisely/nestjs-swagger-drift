// Deliberately NO ambient `@nestjs/common` stub anywhere in this fixture,
// and no real package installed — this reproduces the Phase 1 review's B2
// (round 2) repro exactly: a project where `@nestjs/common` genuinely
// cannot be resolved (not installed yet, or an unresolvable monorepo
// tsconfig). This must NOT result in an empty, silently "clean" route
// table — see test/integration/unresolved-module.test.ts.
import { Controller, Get } from '@nestjs/common';

@Controller('users')
export class UsersController {
  @Get()
  findAll(): string {
    return 'all users';
  }
}
