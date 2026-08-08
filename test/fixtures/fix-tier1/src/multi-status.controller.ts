// One handler that can produce two distinct undocumented statuses (a direct
// throw plus its own implicit success code) — exercises inserting more than
// one `@Api*Response` decorator onto the SAME method in one fix pass.
import { Controller, ConflictException, Post } from '@nestjs/common';

@Controller('multi-status')
export class MultiStatusController {
  @Post()
  create(flag: boolean): string {
    if (flag) throw new ConflictException('already exists');
    return 'created';
  }
}
