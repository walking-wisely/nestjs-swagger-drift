// Export-shape fixtures for §10.3's cross-file "is this class actually
// importable as `{ ClassName }`?" gate (`isExportedUnderOwnName`).
import { ApiProperty } from '@nestjs/swagger';

/** `export default class` — the module has NO named export `DefaultDto`, so
 * `import { DefaultDto } from './export-shapes.js'` is a TS2614 compile
 * error. Tier 2 must NOT emit `type: DefaultDto` for it. */
export default class DefaultDto {
  @ApiProperty()
  id!: string;
}

/** Detached `export { ... }` rather than an `export` modifier: still a
 * perfectly importable named export, so Tier 2 must still resolve it. */
class DetachedDto {
  @ApiProperty()
  id!: string;
}
export { DetachedDto };

/** Not exported at all, but reachable from a controller through inference
 * off `makeHidden()` — no import can name it, so Tier 2 must skip it. */
class HiddenDto {
  @ApiProperty()
  id!: string;
}
export function makeHidden(): HiddenDto {
  return new HiddenDto();
}

/** `@ApiProperty()` lives on the BASE class only (§10.3 gate 2 must look one
 * level up the `extends` chain). */
export class BaseDto {
  @ApiProperty()
  id!: string;
}
export class InheritedDto extends BaseDto {}

/** `implements` must NOT be mistaken for `extends`: `AccessorMarker` carries
 * no `@ApiProperty()`, and `AccessorDto`'s own accessor is what makes this
 * one pass. */
export interface AccessorMarker {
  label: string;
}
export class AccessorDto implements AccessorMarker {
  @ApiProperty()
  get label(): string {
    return '';
  }
}
