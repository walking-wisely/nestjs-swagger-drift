// Regression fixture for a real bug found running Tier 2 autofix against a
// live `"moduleResolution": "node"` repo (Ever Gauzy): `WidgetDto` is
// already imported here WITHOUT an extension, this project's own
// convention (classic Node resolution has no `.js`-on-a-relative-specifier
// rule the way `nodenext` does). `ensureDtoImport` must recognize this
// import and reuse it — appending `.js` unconditionally (the original bug)
// both fails to recognize the existing import (producing a colliding
// `WidgetDto2` alias and a second, broken import of the same class) and
// emits a specifier that doesn't resolve under this project's own
// `moduleResolution`, a real `TS2307` under `tsc --noEmit`.
import { Controller, Get, Body, Post } from '@nestjs/common';
import { WidgetDto } from './dto';

@Controller('widgets')
export class ReusedImportController {
  @Post()
  async create(@Body() body: WidgetDto): Promise<void> {
    void body;
  }

  @Get(':id')
  async findOne(): Promise<WidgetDto> {
    return new WidgetDto();
  }
}
