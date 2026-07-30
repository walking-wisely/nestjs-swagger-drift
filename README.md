# nestjs-swagger-drift

Catch NestJS endpoints whose Swagger docs have drifted from the code.

For every controller handler it works out which HTTP status codes the code can
actually produce — following `throw` statements through your services, mapping
exception classes (including your own) to status codes — then diffs that against
what the `@ApiResponse` decorators claim.

```
src/users/users.controller.ts:42:3  error
  POST /users (UserController.create) is missing @ApiResponse for:
    409 ConflictException
       └ UsersService.create  src/users/users.service.ts:88
    404 NotFoundException
       └ UsersService.create → OrgRepository.findOne  src/org/org.repository.ts:31
```

Deterministic, zero-config, CI-shaped. CLI first, ESLint plugin next, autofix
after that.

**Status: in development (Phase 0/1).** See [PLAN.md](./PLAN.md) for the full
design, scope boundaries, and prior-art analysis.

## Scope

This catches checks that **exist but aren't documented**. It does not catch
checks that _should_ exist but were never written — that's a semantic problem,
not a static one.

## License

MIT
