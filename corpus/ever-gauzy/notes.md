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
