// Guards against false positives on the most common real-world NestJS
// shape: a `try`/`catch` around a throw. `thrown.ts`'s "silence over noise"
// rule says a throw inside a `try` block that has a `catch` never reaches
// the caller, so it must never be treated as producible — and therefore
// never needs documenting.
import { Controller, Get, Post, Put, NotFoundException, BadRequestException } from '@nestjs/common';
import { ApiOkResponse, ApiCreatedResponse, ApiBadRequestResponse } from '@nestjs/swagger';

@Controller('try-catch')
export class TryCatchController {
  // `try { throw } catch { return }` swallows the exception entirely —
  // nothing here is producible, so nothing needs documenting.
  @Get(':id')
  @ApiOkResponse({ description: 'a widget, or null if lookup failed' })
  findOne(id: string): string | null {
    try {
      if (!id) throw new NotFoundException('missing id');
      return 'widget';
    } catch {
      return null;
    }
  }

  // The `catch` remaps to a different, documented exception — only the
  // remapped 400 is producible (the original 404 is swallowed), and it IS
  // documented, so this must produce no finding.
  @Post()
  @ApiCreatedResponse({ description: 'created' })
  @ApiBadRequestResponse({ description: 'invalid payload' })
  create(name: string) {
    try {
      if (!name) throw new NotFoundException('name lookup failed');
      return 'created';
    } catch {
      throw new BadRequestException('invalid payload');
    }
  }

  // `try`/`catch`/`finally`: the `try` throw is swallowed by the `catch`,
  // but the `finally` block's own throw always runs and always propagates.
  @Put(':id')
  @ApiOkResponse({ description: 'replaced' })
  @ApiBadRequestResponse({ description: 'id required' })
  replace(id: string): string {
    try {
      if (!id) throw new NotFoundException('missing id');
      return 'replaced';
    } catch {
      // handled, nothing rethrown here
    } finally {
      if (!id) throw new BadRequestException('id required, checked again in finally');
    }
    return 'replaced';
  }
}
