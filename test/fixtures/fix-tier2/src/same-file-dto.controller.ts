// Positive case, no import needed: the DTO is declared in the SAME file as
// the controller, so `ensureDtoImport` must return the class's own name
// without adding or touching any import declaration.
import { Controller, Post } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';

export class LocalDto {
  @ApiProperty()
  value!: number;
}

@Controller('local')
export class SameFileDtoController {
  @Post()
  async create(): Promise<LocalDto> {
    return new LocalDto();
  }
}
