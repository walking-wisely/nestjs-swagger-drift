// Phase 4 review, finding S6: cross-file suppression (a directive above a
// throw in a shared service, honored for every caller — see
// `suppress.ts`'s module doc) had zero test coverage; every existing
// suppression test lived in a single file. This pairs with
// `cross-file-suppressed.controller.ts`, which calls into this service and
// has no throw of its own — so any finding it produces can only have come
// from resolving the call graph into this file.
import { Injectable, ConflictException, NotFoundException } from '@nestjs/common';

@Injectable()
export class CrossFileSuppressedService {
  findOne(id: string): string {
    if (id === 'conflict') {
      throw new ConflictException('already exists');
    }
    // swagger-drift-disable-next-line 404
    throw new NotFoundException('widget not found');
  }
}
