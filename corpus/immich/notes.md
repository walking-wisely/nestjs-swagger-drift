# immich: notes

## Fixed: wrapper around a swagger response decorator

`DownloadController.downloadArchive` reported an undocumented 200, but its `@FileResponse()`
(`server/src/middleware/auth.guard.ts:63`) is `() => ApiOkResponse({ ... })` from `@nestjs/swagger`.
Local decorators that compose swagger response decorators are now read from their source
(`src/core/response-wrappers.ts`), so the finding is gone. Baseline 385 findings became 384.
