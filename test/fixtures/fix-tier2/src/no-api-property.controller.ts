// Negative case, gate 2 only: the resolved type IS a class (gate 1 passes),
// but it carries no `@ApiProperty()` member, so the emitted schema would be
// empty/misleading -- falls back to the untyped Tier 1 stub.
import { Controller, Get } from '@nestjs/common';
import { UndocumentedDto } from './dto.js';

@Controller('undocumented')
export class NoApiPropertyController {
  @Get()
  async find(): Promise<UndocumentedDto> {
    return new UndocumentedDto();
  }
}
