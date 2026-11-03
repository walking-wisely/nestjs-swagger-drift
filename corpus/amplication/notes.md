# Amplication notes

Pin `7656495d27f0dceff89657590c3f14149e45c7a6`, `packages/amplication-server`.
Baseline: 3 findings, all implicit-success (no thrown-status sources). 2 TP, 1 FP, 0 UNCLEAR.

## FP classes

- **Passport redirect guard (not fixed).** `AuthController.github` (`auth.controller.ts:46`)
  is guarded by `GitHubAuthGuard extends AuthGuard("github")`. With no OAuth code,
  `passport-oauth2` redirects to GitHub through `strategy.redirect`, which ends the response, and
  `@nestjs/passport` awaits a promise that never resolves, so the handler body never runs.
  The real status is 302. Knowing this needs library semantics, so a syntactic tool cannot
  clear it.

## Reviewer caveats

- The other two are plain `@Post` handlers with no `@HttpCode` and no `@ApiResponse`; the
  implicit 201 is real.
- The REST surface is tiny. The server is GraphQL-first, so this baseline says nothing about
  GraphQL resolvers (the tool does not analyse them).
