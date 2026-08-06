// m6 (Phase 6 ESLint-plugin review): a genuinely cross-FILE unresolvable
// throw, reached one call-graph hop away from
// `unresolvable-cross-file.controller.ts`. `unresolvable.controller.ts`'s
// `FlakyService` (same directory) looks cross-*class* but is actually
// same-*file*, so `documented-status-codes.ts`'s `reportNodeFor` cross-file
// fallback (anchoring at the handler's `MethodDefinition` because
// `services.tsNodeToESTreeNodeMap` has no entry for a node from a DIFFERENT
// file's AST) was never actually exercised until this pair of files existed.
import { HttpException, Injectable } from '@nestjs/common';

@Injectable()
export class FlakyCrossFileService {
  check(id: string): string {
    const dynamicStatus = id.length; // deliberately not a literal
    if (!id) throw new HttpException('bad id', dynamicStatus);
    return 'ok';
  }
}
