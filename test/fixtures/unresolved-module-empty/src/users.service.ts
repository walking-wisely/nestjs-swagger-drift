// No @Controller anywhere in this fixture, but @nestjs/common is still
// unresolvable (see unresolved-module/ sibling fixture). This is the case
// the CLI's EXIT_COULD_NOT_ANALYSE exit code exists for: zero routes found
// AND the checker couldn't confirm @nestjs/common resolves, so "zero" must
// not be reported as a clean, trustworthy result.
import { Injectable } from '@nestjs/common';

@Injectable()
export class UsersService {
  find(): string {
    return 'x';
  }
}
