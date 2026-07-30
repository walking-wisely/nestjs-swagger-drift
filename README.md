# nestjs-endpoint-doctor

Static analysis for NestJS controllers: every HTTP status code a handler can
actually produce must be documented with an `@ApiResponse`-family decorator.

```
src/users/users.controller.ts:42:3  error
  POST /users (UserController.create) is missing @ApiResponse for:
    409 ConflictException
       └ UsersService.create  src/users/users.service.ts:88
```

**Status: planning.** See [PLAN.md](./PLAN.md).
