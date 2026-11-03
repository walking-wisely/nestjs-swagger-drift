# nestjs-swagger-drift — implementation plan

> Renamed 2026-07-30 from `nestjs-endpoint-doctor`. See §1.1 — the existing
> `nestjs-doctor` package made the original name a collision risk.

> Static analysis for NestJS controllers: every HTTP status code the handler can
> actually produce must be documented with a `@ApiResponse`-family decorator.
>
> Origin: `Vault/ideas/code-analysis-tool-that-would-help-with-keepin.md`

---

## Contents

The plan is split by section. **Section numbers are stable and are cited from
code comments (`PLAN §10.2`, `PLAN §5 Phase 4`, …)** — renumbering a section
breaks those references, so sections keep their numbers even as files move.

| § | Topic | File |
|---|---|---|
| 0 | The one-line thesis | *(below)* |
| 1 | Product shape | [`docs/plan/01-product-shape.md`](./docs/plan/01-product-shape.md) |
| 2 | The two questions you asked, answered first | [`docs/plan/02-eslint-questions.md`](./docs/plan/02-eslint-questions.md) |
| 3 | Architecture | [`docs/plan/03-architecture.md`](./docs/plan/03-architecture.md) |
| 4 | The checks | [`docs/plan/04-checks.md`](./docs/plan/04-checks.md) |
| 5 | Phases | [`docs/plan/05-phases.md`](./docs/plan/05-phases.md) |
| 6 | Known gaps (document them, don't hide them) | [`docs/plan/06-known-gaps.md`](./docs/plan/06-known-gaps.md) |
| 7 | Testing strategy | [`docs/plan/07-testing-strategy.md`](./docs/plan/07-testing-strategy.md) |
| 8 | Positioning / why this can be real | [`docs/plan/08-positioning.md`](./docs/plan/08-positioning.md) |
| 9 | Open decisions | [`docs/plan/09-open-decisions.md`](./docs/plan/09-open-decisions.md) |
| 10 | Phase 7 — Autofix (detailed design) | [`docs/plan/10-autofix.md`](./docs/plan/10-autofix.md) |
| 11 | Real-world corpus validation (partially implemented) | [`docs/plan/11-corpus-validation.md`](./docs/plan/11-corpus-validation.md) |
| 12 | Next steps | [`docs/plan/12-next-steps.md`](./docs/plan/12-next-steps.md) |

---

## 0. The one-line thesis

AI-generated (and human-generated) NestJS endpoints throw exceptions that never
make it into Swagger. The mapping *thrown exception class → HTTP status code* is
deterministic in NestJS, so a linter can diff **what the code can throw** against
**what the decorators claim** and fail CI on the delta.

Scope boundary, stated up front: this catches *checks that exist but aren't
documented*. It does **not** catch *checks that should exist but were never
written* — that's a semantic problem, not a static one, and belongs to a
different tool.

---
