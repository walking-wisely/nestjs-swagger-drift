// Guards against a false positive when a LOCAL class happens to share a name
// with a real `@nestjs/common` exception — `provenance.ts`'s checker-based
// resolution must classify this as `'mismatch'` (a same-named symbol
// declared somewhere that is NOT `@nestjs/common`), which
// `resolve-status.ts`'s `tryBuiltInExceptionClass` explicitly falls through
// on rather than guessing 404 from the name alone. This is deliberately
// undocumented — it must produce nothing precisely BECAUSE it isn't a real
// Nest exception, not because it happens to be documented.
import { Controller, Get } from '@nestjs/common';

// Not imported from `@nestjs/common` — an unrelated local class that merely
// shares a name with a built-in exception (e.g. a copy-pasted DTO/error type
// before someone remembered to import the real one).
class NotFoundException extends Error {
  constructor(message: string) {
    super(message);
  }
}

@Controller('shadowed-name')
export class ShadowedNameController {
  @Get(':id')
  findOne(id: string): string {
    if (!id) throw new NotFoundException('this is not the real NotFoundException');
    return 'widget';
  }
}
