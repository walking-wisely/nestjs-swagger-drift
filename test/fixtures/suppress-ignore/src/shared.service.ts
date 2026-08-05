// Reached only through `call-graph-caller.controller.ts`, which the test
// `--ignore`s. Carries a real, working suppression directive that fires via
// the call graph when its only caller isn't ignored — the cross-file half
// of the regression under test.
import { Injectable, NotFoundException } from '@nestjs/common';

@Injectable()
export class SharedService {
  findOne(id: string): string {
    // swagger-drift-disable-next-line 404
    throw new NotFoundException('widget not found');
  }
}
