import { ApiProperty } from '@nestjs/swagger';

/** Gate 2 (PLAN §10.3) passes: at least one `@ApiProperty()` member. */
export class WidgetDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  name!: string;
}

/** Gate 2 fails: a plain class, no `@ApiProperty()` anywhere. */
export class UndocumentedDto {
  id!: string;
}

/** Gate 1 fails: an interface, no runtime constructor to reflect via `@ApiProperty`. */
export interface WidgetPage {
  items: WidgetDto[];
  total: number;
}
