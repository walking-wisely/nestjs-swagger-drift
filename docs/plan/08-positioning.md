> Part of the [nestjs-swagger-drift implementation plan](../../PLAN.md).
> Section numbers are stable — 200+ code comments cite `PLAN §8`.

---

## 8. Positioning / why this can be real

Nothing does this for NestJS today. `springdoc` generates docs from code (Java),
`buf lint` covers protobuf, `@nestjs/swagger`'s CLI plugin infers _types_ but not
_status codes_. The wedge is narrow and the pain is concrete and increasing with
AI-authored endpoints. Small, deterministic, zero-config, CI-shaped — that's a
tool people actually adopt.

Distribution order that maximizes the chance anyone uses it: CLI first (works in
any repo, one command, great README screenshot) → ESLint plugin (meets teams
where they already are) → autofix (the thing that makes it beloved).
