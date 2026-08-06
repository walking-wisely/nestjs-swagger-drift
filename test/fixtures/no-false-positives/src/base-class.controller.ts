// Guards against a false positive on inherited class-level documentation
// (PLAN §4.3 review S1): `@nestjs/swagger` reads class-level
// `@ApiResponse`-family metadata via `Reflect.getMetadata`, which walks the
// prototype chain, so a class-level `@ApiNotFoundResponse` on `BaseController`
// genuinely documents `DerivedController`'s own handlers too, even though
// `DerivedController` carries no method- or class-level decorator of its
// own. `documented.ts`'s `collectClassChainStatuses` must walk the `extends`
// chain to see it.
import { Controller, Get, NotFoundException } from '@nestjs/common';
import { ApiNotFoundResponse, ApiOkResponse } from '@nestjs/swagger';

// Deliberately not itself a `@Controller` — a shared abstract base carrying
// only the documentation, the common real-world shape.
@ApiNotFoundResponse({ description: 'resource not found' })
export class BaseController {}

@Controller('base-class')
export class DerivedController extends BaseController {
  @Get(':id')
  @ApiOkResponse({ description: 'a widget' })
  findOne(id: string): string {
    if (!id) throw new NotFoundException('resource not found');
    return 'widget';
  }
}
