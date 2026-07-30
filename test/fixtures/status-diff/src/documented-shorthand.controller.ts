// Correct documentation via the shorthand decorator family — must produce
// no finding.
import { Controller, Post, ConflictException } from '@nestjs/common';
import { ApiConflictResponse } from '@nestjs/swagger';

@Controller('shorthand-documented')
export class DocumentedShorthandController {
  @Post()
  @ApiConflictResponse({ description: 'already exists' })
  create(): string {
    throw new ConflictException('already exists');
  }
}
