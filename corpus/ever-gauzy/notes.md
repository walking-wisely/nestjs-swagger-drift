# ever-gauzy: known false-positive classes

## Fixed: flag-guarded throws in RequestContext

`RequestContext.currentUser`, `hasPermissions`, `hasAnyPermission`, `hasRoles` and
`currentToken` throw a 401 only under `if (throwError)`
(`packages/core/src/lib/core/context/request-context.ts:417`, `482`, `508`, `532`, `572`).
Every caller in `packages/` invokes them with no flag, or with `false`, directly or through
`currentTenantId`, `currentUserId`, `currentRoleName` and friends. The throws never run, yet
124 findings reported a 401 through them.

Cause: the analyser treated any `if` whose condition was not a literal falsy value as possibly
true and carried no call-site arguments into the callee. The call graph now binds literal
arguments to callee parameters and skips branches they decide (`src/core/const-eval.ts`).

Verified 2026-11-02 by a blind reviewer, an adversarial reviewer and a 5-chain hand check
(grep-based over `packages/`, no type checker). After the fix: 824 findings became 700, none
new, and 4 more findings lost only the dead source. Baseline rebaselined with the 700 findings
as `UNTRIAGED`.

## Triaged false-positive classes

- Guard needs an input the caller never produces (`tenant-aware-crud.service.ts` delete empty-criteria 400, `assertNotForeignRow` 403): not fixable without object-shape data flow.
- `!id` guard behind `UUIDValidationPipe` (`crud.service.ts:534`): pipe preconditions are not modelled. The pipe itself yields 404/406, which is not reported either.
- `typeof` narrowing of a union-typed argument (`crud.service.ts:641`): fixed; call-site argument types now decide `typeof` guards.
- Correlated guards across frames (`billing.service.ts:583`).
- `@ApiExcludeController` / `@ApiExcludeEndpoint` handlers (`StripeWebhookController`): fixed; excluded handlers are no longer analysed.

Implicit-success findings (357) were all true positives apart from the excluded controller. 126 handlers send 202 but document another 2xx; 43 document 200 while Nest sends 201.

## Confidence marker

On the 698 current findings, 205 are marked `confidence: low` (every source is a throw inside a catch block). Against the recorded verdicts: 35 of the 41 FPs and all 3 UNCLEAR are low; 65 TPs are low too (catch-all repository-error remaps), so low means "check before acting", not "wrong".
