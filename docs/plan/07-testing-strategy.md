> Part of the [nestjs-swagger-drift implementation plan](../../PLAN.md).
> Section numbers are stable — 200+ code comments cite `PLAN §7`.

---

## 7. Testing strategy

- **Fixture-driven, snapshot-verified.** Each `test/fixtures/<case>/` is a tiny
  NestJS-shaped project plus `expected.json` (the exact Findings). Adding a case
  is copying a folder — this keeps the iteration loop fast in Phase 3.
- **A "no false positives" corpus.** A directory of _correctly documented_
  controllers pulled from real code. The suite asserts the tool reports nothing.
  This is the regression net that keeps the tool trustworthy.
- **Unit tests** for `resolve-status.ts` (the trickiest logic) against
  hand-written class hierarchies.
- **RuleTester** suite in Phase 6, asserting parity with the engine.
