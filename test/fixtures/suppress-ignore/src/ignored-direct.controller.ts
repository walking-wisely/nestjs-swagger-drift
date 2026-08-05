// Directly `--ignore`d by the test that uses this fixture. Carries a real,
// working suppression directive — the regression under test is that
// `--ignore`ing this file must not make the CLI warn that the directive
// "did not suppress anything."
import { Controller, Get, ConflictException, NotFoundException } from '@nestjs/common';

@Controller('ignored-direct')
export class IgnoredDirectController {
  @Get(':id')
  findOne(id: string): string {
    if (id === 'conflict') {
      throw new ConflictException('already exists');
    }
    // swagger-drift-disable-next-line 404
    throw new NotFoundException('widget not found');
  }
}
