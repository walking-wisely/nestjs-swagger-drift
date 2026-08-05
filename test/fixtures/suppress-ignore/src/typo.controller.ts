// Never `--ignore`d by the test that uses this fixture — its directive
// names the wrong status (`409`, but the throw beneath it is a `404`), so it
// genuinely suppresses nothing. Proves the "unused directive" warning still
// fires for a real typo, and isn't blanket-disabled by `--ignore`ing the
// other fixture files.
import { Controller, Get, NotFoundException } from '@nestjs/common';

@Controller('typo')
export class TypoController {
  @Get(':id')
  findOne(id: string): string {
    // swagger-drift-disable-next-line 409
    throw new NotFoundException('widget not found');
  }
}
