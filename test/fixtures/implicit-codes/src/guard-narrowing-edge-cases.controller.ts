// `guard-narrowing.ts` fixture, edge cases — see `guard-narrowing-edge-cases.guard.ts`.
import { All, Controller, Get, UseGuards } from '@nestjs/common';
import {
  AllMethodGuard,
  LiteralKeyDecorator,
  LiteralKeyGuard,
  MapLookupGuard,
  NestedFactoryGuard,
  NestedRoleDecorator,
  OrConditionGuard,
} from './guard-narrowing-edge-cases.guard.js';

@Controller('guard-narrowing-edge-cases')
export class GuardNarrowingEdgeCasesController {
  // A `.get(...)` on a plain `Map`, not a `Reflector` — must stay reachable.
  @UseGuards(MapLookupGuard)
  @Get('map-lookup')
  mapLookup(): string[] {
    return [];
  }

  // An `@All()` handler under an HTTP-method-gated guard — must stay reachable.
  @UseGuards(AllMethodGuard)
  @All('all-method')
  allMethod(): string[] {
    return [];
  }

  // Decorator sets the key as a literal; guard reads it via a shared const —
  // must still match (reachable when the decorator IS present).
  @UseGuards(LiteralKeyGuard)
  @LiteralKeyDecorator('x')
  @Get('literal-key-present')
  literalKeyPresent(): string[] {
    return [];
  }

  // Same guard, decorator absent — must be narrowed away.
  @UseGuards(LiteralKeyGuard)
  @Get('literal-key-absent')
  literalKeyAbsent(): string[] {
    return [];
  }

  // Decorator composed via `applyDecorators(InnerRole(...))` — must still be
  // traced through to the underlying `SetMetadata` call (reachable when present).
  @UseGuards(NestedFactoryGuard)
  @NestedRoleDecorator()
  @Get('nested-factory-present')
  nestedFactoryPresent(): string[] {
    return [];
  }

  // Same guard, decorator absent — must be narrowed away.
  @UseGuards(NestedFactoryGuard)
  @Get('nested-factory-absent')
  nestedFactoryAbsent(): string[] {
    return [];
  }

  // `flag || <write-method check>` — neither disjunct holds for this
  // GET handler with no decorator, but `||` must never be narrowed.
  @UseGuards(OrConditionGuard)
  @Get('or-condition')
  orCondition(): string[] {
    return [];
  }
}
