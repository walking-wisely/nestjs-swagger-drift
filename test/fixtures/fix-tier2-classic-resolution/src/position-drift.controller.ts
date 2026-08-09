// Regression fixture for a real bug found running Tier 2 autofix against a
// live repo (Ever Gauzy): `applyFixesToFile` used to interleave resolving a
// method's `pos` with mutating the file (decorator inserts, and Tier 2's
// `ensureDtoImport`). Processing methods in descending-position order made
// that safe for decorator inserts alone (they only shift positions AFTER
// the insertion point), but `ensureDtoImport` lands its new import near the
// TOP of the file regardless of which method triggered it — so fixing
// `findGadget` here (the later method, processed first) used to shift
// `findFirst`'s still-unresolved `pos` out from under it, and the fixer
// reported a real, still-present handler as "moved or removed since
// analysis" and silently dropped its fix.
//
// `findFirst` needs no import at all (its finding is a plain error-status
// throw); `findGadget` needs a brand-new import of `GadgetDto` — resolved
// purely through return-type INFERENCE off `makeGadget()` (see
// `gadget-factory.ts`, which is the only thing this file imports; it never
// imports anything from `./dto` directly), so `GadgetDto`/`./dto` have no
// binding of any kind here to begin with, forcing `ensureDtoImport` down
// its "add a fresh import declaration" path — not a merge into an existing
// one. Both must end up in `applied`.
import { Controller, Get, NotFoundException } from '@nestjs/common';
import { makeGadget } from './gadget-factory';

@Controller('items')
export class PositionDriftController {
  @Get('first')
  async findFirst(): Promise<void> {
    throw new NotFoundException();
  }

  @Get('gadget')
  async findGadget() {
    return makeGadget();
  }
}
