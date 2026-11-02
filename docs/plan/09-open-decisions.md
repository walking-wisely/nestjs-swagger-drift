> Part of the [nestjs-swagger-drift implementation plan](../../PLAN.md).
> Section numbers are stable — 200+ code comments cite `PLAN §9`.

---

## 9. Open decisions

- [x] License: **MIT** (decided 2026-07-30).
- [x] Name: **`nestjs-swagger-drift`** (decided 2026-07-30, see §1.1).
- [ ] **Distribution strategy — the big one, deferred to Phase 5/6.** Three
      routes, and the pure-core architecture (§2.1) means the engine is identical
      under all of them, so this genuinely can be decided late: 1. _Standalone_ CLI + ESLint plugin. Full control, hardest distribution. 2. _Ship as a `nestjs-doctor` custom rule_ — it supports `customRulesDir`
      with a `meta`+`check` contract and already exposes `endpointGraph` on
      the analysis context. Instant reach to ~7k weekly users. 3. _Contribute the rule to `@darraghor/eslint-plugin-nestjs-typed`_, which
      already has a Swagger rule group and the audience.
      Routes 2 and 3 trade the differentiator away — it becomes a feature of
      someone else's product. Not necessarily wrong; decide with real usage data.
- [ ] Package layout: single package with subpath exports vs. monorepo from the
      start. _Lean: single package until Phase 6._
- [ ] Is `documented-but-unreachable` valuable enough to build? It catches
      copy-pasted decorator blocks, which is a real AI failure mode.
- [ ] Should success-code checking (`@ApiOkResponse` presence) be on by default?
      _Lean: yes — it's the most common miss and has no false-positive risk._
- [ ] Support `@ApiException(...)` from
      `@nanogiants/nestjs-swagger-api-exception-decorator` as a _documented_
      source (§4.3). Cheap, and avoids false positives for that library's users.
