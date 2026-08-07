// Issue #17 / `parse-pipes.ts`: the implicit 400 (or, for an
// `errorHttpStatusCode` override, whatever other status the pipe actually
// throws) from a built-in `Parse*Pipe` applied to a request-data parameter
// decorator, opt-in via `AnalysisOptions.checkParsePipes`.
import {
  Controller,
  Get,
  Post,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  ParseFilePipe,
  ParseEnumPipe,
  ParseDatePipe,
  Query,
  Headers,
  UploadedFile,
  HttpStatus,
} from '@nestjs/common';

// Deliberately not a statically resolvable literal — issue #17
// `errorHttpStatusCode` regression: this must make the pipe usage
// contribute NOTHING (silence over noise), not a guessed `400`.
declare const DYNAMIC_STATUS: number;

enum UserRole {
  Admin = 'admin',
  Member = 'member',
}

// A local `errorHttpStatusCode` const, for the shorthand-property-name
// regression test below (`{ errorHttpStatusCode }`). A literal initializer
// (not `declare const ...: number`) so its type stays the literal `406`,
// not the widened `number`, and `resolveStatusExpression` can resolve it.
const errorHttpStatusCode = 406;

@Controller('parse-pipes')
export class ParsePipesController {
  // A bare class reference as the second argument — must trigger the
  // implicit 400 when the check is enabled.
  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string): string {
    return id;
  }

  // An INSTANTIATED pipe (`new ParseIntPipe()`) rather than a bare class
  // reference — must be recognized the same way.
  @Get()
  list(@Query('page', new ParseIntPipe()) page: number): string {
    return String(page);
  }

  // No pipe argument at all — must never trigger the implicit 400,
  // regardless of whether the check is enabled.
  @Get('plain/:id')
  plain(@Param('id') id: string): string {
    return id;
  }

  // Adversarial review: `new ParseIntPipe({ errorHttpStatusCode })` with a
  // STATICALLY RESOLVABLE override — must report 406, not 400.
  @Get('overridden/:id')
  overridden(
    @Param('id', new ParseIntPipe({ errorHttpStatusCode: HttpStatus.NOT_ACCEPTABLE })) id: number,
  ): string {
    return String(id);
  }

  // Adversarial review: `errorHttpStatusCode` present but NOT statically
  // resolvable — must contribute NO finding at all (not a guessed 400).
  @Get('unresolvable-override/:id')
  unresolvableOverride(
    @Param('id', new ParseIntPipe({ errorHttpStatusCode: DYNAMIC_STATUS })) id: number,
  ): string {
    return String(id);
  }

  // Adversarial review: the array-literal pipe form (`@Query('page',
  // [ParseIntPipe])`) — must be recognized the same as a bare reference.
  @Get('array-form')
  arrayForm(@Query('page', [ParseIntPipe]) page: number): string {
    return String(page);
  }

  // Adversarial review: no property-name argument at all
  // (`@Param(ParseIntPipe)`) — NestJS accepts this shape too.
  @Get('no-property-name/:id')
  noPropertyName(@Param(ParseIntPipe) id: number): string {
    return String(id);
  }

  // Adversarial review: two parameters both carrying `ParseIntPipe` — the
  // detail string must de-duplicate to a single `ParseIntPipe`, not
  // `ParseIntPipe, ParseIntPipe`.
  @Get('duplicate-pipe')
  duplicatePipe(
    @Query('page', ParseIntPipe) page: number,
    @Query('limit', ParseIntPipe) limit: number,
  ): string {
    return `${page}/${limit}`;
  }

  // Adversarial review: `@Headers()` is a request-data decorator a pipe can
  // be attached to just as validly as `@Param`/`@Query`/`@Body` — must be
  // recognized (the old Body/Param/Query-only gate missed this entirely).
  @Get('headers')
  headers(@Headers('x-count', ParseIntPipe) count: number): string {
    return String(count);
  }

  // Adversarial review: `ParseFilePipe` is canonically attached via
  // `@UploadedFile()`, structurally unreachable under the old
  // Body/Param/Query-only gate despite being advertised as supported.
  @Post('upload')
  upload(@UploadedFile(new ParseFilePipe()) file: unknown): string {
    return String(file);
  }

  // Adversarial review, confirmed false positive: `ParseEnumPipe`'s
  // constructor is `(enumType, options?)` — its options object is
  // `arguments[1]`, not `arguments[0]`. Must report 406, not a guessed 400.
  @Get('enum/:role')
  byRole(
    @Param('role', new ParseEnumPipe(UserRole, { errorHttpStatusCode: HttpStatus.NOT_ACCEPTABLE })) role: UserRole,
  ): string {
    return role;
  }

  // Adversarial review, confirmed false positive: `exceptionFactory` takes
  // precedence over `errorHttpStatusCode` at runtime (NestJS's own
  // `exceptionFactory ?? HttpErrorByCode[errorHttpStatusCode]`) — this must
  // contribute NO finding (this tool can't resolve an arbitrary factory's
  // thrown status), not a guessed 400.
  @Get('exception-factory/:id')
  exceptionFactory(
    @Param(
      'id',
      new ParseIntPipe({ exceptionFactory: () => new Error('bad id') }),
    )
    id: number,
  ): string {
    return String(id);
  }

  // Adversarial review, confirmed false positive: shorthand
  // (`{ errorHttpStatusCode }`) and string-literal (`{ 'errorHttpStatusCode':
  // ... }`) property names — both must resolve the override, not silently
  // fall through to a guessed 400.
  @Get('shorthand/:id')
  shorthandOverride(@Param('id', new ParseIntPipe({ errorHttpStatusCode })) id: number): string {
    return String(id);
  }

  @Get('string-literal-name/:id')
  stringLiteralOverride(
    @Param('id', new ParseIntPipe({ 'errorHttpStatusCode': HttpStatus.NOT_ACCEPTABLE })) id: number,
  ): string {
    return String(id);
  }

  // Adversarial review: `ParseDatePipe` was missing entirely from the
  // built-in pipe set — must be recognized like every other `Parse*Pipe`.
  @Get('date')
  dateRange(@Query('from', ParseDatePipe) from: Date): string {
    return from.toISOString();
  }

  // Adversarial review, confirmed false positive: two DISTINCT pipes on the
  // SAME decorator call, each with its own resolvable status — must report
  // BOTH statuses (400 default for `ParseIntPipe`, 422 override for the
  // `ParseUUIDPipe`), not stop at the first pipe found.
  @Get('multi-pipe')
  multiPipe(
    @Query('n', ParseIntPipe, new ParseUUIDPipe({ errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY })) n: unknown,
  ): string {
    return String(n);
  }
}
