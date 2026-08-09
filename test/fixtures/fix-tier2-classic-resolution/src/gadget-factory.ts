import { GadgetDto } from './dto';

/** Returns a `GadgetDto` without `position-drift.controller.ts` (the only
 * caller) ever importing `GadgetDto` — or anything else from `./dto` — by
 * name. Its `findGadget` handler resolves `Promise<GadgetDto>` purely
 * through return-type inference off this function (mirroring the real
 * Ever Gauzy bug: a generic base class's concrete return type reaching a
 * controller with no direct import of the DTO in that file), so that file
 * has ZERO pre-existing import from `./dto` — genuinely exercising
 * `ensureDtoImport`'s "add a brand-new import declaration" path rather than
 * merging into (or reusing a name from) an existing one. */
export function makeGadget(): GadgetDto {
  return new GadgetDto();
}
