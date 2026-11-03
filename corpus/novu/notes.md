# novu: triage notes

Pin `4af47133e2cd5e3de296293e6b21bfd24a6b591f`, `apps/api/tsconfig.json`. 338 findings:
312 FP, 25 TP, 1 UNCLEAR, 0 UNTRIAGED.

## FP class: documentation applied through Novu's own decorator wrappers (312 findings, fixed)

`apps/api/src/app/shared/framework/response.decorator.ts` defines local replacements for the
`@nestjs/swagger` response decorators, and controllers import those instead of the swagger ones:

- `ApiResponse(Dto, statusCode = 200, ...)` (`response.decorator.ts:121`) switches on the numeric
  argument and applies the matching swagger decorator (`ApiOkResponse`, `ApiCreatedResponse`, ...).
- `ApiOkResponse`, `ApiCreatedResponse`, `ApiNoContentResponse`, `ApiNotFoundResponse`, ... are
  re-exports of `customResponseDecorators` (`response.decorator.ts:25-70`), each built with
  `applyDecorators`.
- `ApiCommonResponses()` (`response.decorator.ts:312`) is a class-level decorator that applies
  `ApiResponse(ErrorDto, N)` for 400, 401, 403, 404, 405, 409, 413, 414, 415, 422, 500, plus
  429/503 (and 409) from `constants/responses.schema.ts`.

The analyser only recognises decorators imported from `@nestjs/swagger`, so every status these
wrappers document is reported as undocumented.

- 125 implicit-success findings: the handler documents its 2xx through the local `ApiResponse`
  / `ApiOkResponse` / `ApiCreatedResponse` / `ApiNoContentResponse` with the same status the
  tool reports.
- 187 thrown-status findings: the status is in the `ApiCommonResponses()` set (or a local
  `Api*Response`) on the class or method.

Checked per finding with the TypeScript AST over the handler and class decorators, plus the
import source of each decorator name.

Fix: `src/core/response-wrappers.ts` reads wrapper bodies (`applyDecorators`, nested wrappers,
`switch` over bound arguments), so `ApiResponse(Dto, 201)` resolves from its switch. The
local `ApiOkResponse`-style exports come from a `reduce` over the swagger exports and
`ApiCommonResponses` builds its list in a loop; neither is decidable statically, so
`corpus/novu/swagger-drift.config.json` lists them under `responseDecorators`. Those entries are
trusted: if Novu changes the statuses `ApiCommonResponses` applies, the config goes stale
silently.

After the fix the baseline holds 26 findings (25 TP, 1 UNCLEAR); the 312 FP entries were
dropped on rebaseline.

Reachability of the 187 thrown findings was not judged; they are FP because the status is documented, not
because the throw is dead.

## Remaining findings (26)

- 17 implicit-success TP: handlers with no response decorator at all (`ActivityController`
  x5, six 204 handlers under `SubscribersController`, `WorkflowController.removeWorkflow`,
  `LayoutsController.delete`, `ContextsController.deleteContext`, `ChannelConnections`/
  `ChannelEndpoints` deletes, `EnvironmentsControllerV1.deleteEnvironment`).
- 1 implicit-success TP: `IntegrationsController.autoConfigureIntegration` documents
  `ApiResponse(Dto, 200)` but is a `@Post` with no `@HttpCode`, so Nest sends 201
  (`integrations.controller.ts:375`).
- 7 thrown TP: `ActivityRetentionService` 402 (`activity-retention.service.ts:107`, client-supplied
  `after`/`before` beyond the plan retention) reached from `getCharts` and `listNotifications`;
  `GetRequest` 404 (`get-request.usecase.ts:38`, client-supplied `requestId`); email-tier 402
  (`add-agent-integration.usecase.ts:303`, hosted-tier deployments only); Telegram `getMe`
  failures as 502 (`configure-telegram-webhook.usecase.ts:176`, client-supplied bot token);
  snooze duration over tier limit 402 (`snooze-notification.usecase.ts:143`).
- 1 UNCLEAR: `getCharts` 500 (`activity-retention.service.ts:77`), organization row missing for
  an authenticated organization id.

## Reviewer caveats

No subagent reviewers were used: after the wrapper class was removed only 26 findings needed a
reachability judgement, and they were read directly. No known-answer calibration items were
mixed in.
