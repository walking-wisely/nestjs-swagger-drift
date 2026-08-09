import { GadgetDto } from './dto';

/** Returns a `GadgetDto` without `position-drift.controller.ts` (the only
 * caller) ever importing `GadgetDto` — or anything else from `./dto` — by
 * name. Its `findGadget` handler resolves `Promise<GadgetDto>` purely
 * through return-type inference off this function, so that file
 * has ZERO pre-existing import from `./dto` — genuinely exercising
 * `ensureDtoImport`'s "add a brand-new import declaration" path rather than
 * merging into (or reusing a name from) an existing one.
 *
 * NB: this is plain function-return-type inference, NOT generic
 * substitution — it shares only the "DTO type reaches the controller with
 * no import of it in that file" shape with the Ever Gauzy case, and would
 * not by itself have caught a generic-base-class resolution bug. Generic
 * substitution is `resolveSuccessResponseType`'s own concern and is
 * documented on that function. */
export function makeGadget(): GadgetDto {
  return new GadgetDto();
}
