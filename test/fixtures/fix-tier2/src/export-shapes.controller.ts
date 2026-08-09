// Drives every class in `export-shapes.ts` through Tier 2's cross-file
// export gate and its gate-2 heritage/accessor walk.
import { Controller, Get } from '@nestjs/common';
import DefaultDto, { DetachedDto, InheritedDto, AccessorDto, makeHidden } from './export-shapes.js';

@Controller('export-shapes')
export class ExportShapesController {
  @Get('default')
  async defaultExported(): Promise<DefaultDto> {
    return new DefaultDto();
  }

  @Get('detached')
  async detachedExport(): Promise<DetachedDto> {
    return new DetachedDto();
  }

  @Get('hidden')
  async notExported() {
    return makeHidden();
  }

  @Get('inherited')
  async inherited(): Promise<InheritedDto> {
    return new InheritedDto();
  }

  @Get('accessor')
  async accessor(): Promise<AccessorDto> {
    return new AccessorDto();
  }
}
