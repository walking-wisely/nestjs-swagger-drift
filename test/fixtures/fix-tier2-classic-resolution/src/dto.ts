import { ApiProperty } from '@nestjs/swagger';

/** Gate 2 (PLAN §10.3) passes: at least one `@ApiProperty()` member. */
export class WidgetDto {
  @ApiProperty()
  id!: string;
}

/** A second, independent class DTO — used to force `ensureDtoImport` down
 * its "add a brand-new import" path (as opposed to `WidgetDto`, which the
 * fixture controllers already import for an unrelated reason). See
 * `gadget-factory.ts` for why `position-drift.controller.ts` never imports
 * from this file directly. */
export class GadgetDto {
  @ApiProperty()
  id!: string;
}
