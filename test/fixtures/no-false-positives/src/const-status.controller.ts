// Guards against false positives when a documented `status` doesn't appear
// as a bare numeric literal at the decorator use site — `documented.ts`'s
// various fallback resolution paths (PLAN §4.3 review S2) must still pin
// these down to a concrete status.
import { Controller, Get, Post, Delete, Patch, NotFoundException } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';

// A plain `const` primitive keeps its literal type at every read site (TS
// never widens a `const` primitive the way it widens `let`), so
// `resolveStatusExpression`'s `type.isNumberLiteral()` check sees `404`
// directly, whether read from a method body or from a decorator argument.
const NOT_FOUND_STATUS = 404;
const NOT_FOUND_DESCRIPTION = 'not found, via shorthand property';

// An object literal's own properties ARE widened by default, so `BASE.status`
// alone would type as plain `number` — `as const` keeps it literal, which is
// what lets the spread-only case below resolve via the argument's own type.
const BASE_NOT_FOUND = { status: 404, description: 'base not found' } as const;

// Named to match the `status`/`description` property keys exactly, so the
// decorator below can use shorthand property assignment.
const status = 404;
const description = NOT_FOUND_DESCRIPTION;

@Controller('const-status')
export class ConstStatusController {
  // `@ApiResponse({ status: SOME_CONST })` — a bare identifier reference to a
  // module-level `const` primitive.
  @Get('const-ref')
  @ApiResponse({ status: NOT_FOUND_STATUS, description: 'not found' })
  findByConstRef(): string {
    throw new NotFoundException('not found');
  }

  // `@ApiResponse({ ...BASE, status: 404 })` — spread plus an explicit,
  // directly-literal `status` override; the direct property wins regardless
  // of what `BASE` itself contains.
  @Post('spread-and-explicit')
  @ApiResponse({ ...BASE_NOT_FOUND, status: 404, description: 'explicit override' })
  createWithSpreadAndExplicit(): string {
    throw new NotFoundException('not found');
  }

  // Spread-only: the status arrives purely through `...BASE_NOT_FOUND`, with
  // no direct `status` property at the use site at all.
  @Delete('spread-only')
  @ApiResponse({ ...BASE_NOT_FOUND })
  removeViaSpreadOnly(): void {
    throw new NotFoundException('not found');
  }

  // `{ status, description }` shorthand property assignment — `status`/
  // `description` here are module-level `const`s (decorator arguments are
  // evaluated in the class declaration's own scope, so they can't reference
  // a method-local variable) referenced by name, doubling as both property
  // key and value.
  @Patch('shorthand-prop')
  @ApiResponse({ status, description })
  updateViaShorthand(): string {
    throw new NotFoundException('not found');
  }
}
