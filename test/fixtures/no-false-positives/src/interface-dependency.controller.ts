// PLAN §4.1b: an interface-typed dependency. NestJS DI usually resolves a
// concrete class fine, but here the constructor parameter is statically
// typed as an interface with no body at all — the checker can't pin down
// which concrete implementation is actually injected, so the call graph
// must resolve to nothing rather than guessing at (or unioning) every class
// that happens to implement the interface.
import { Controller, Get, NotFoundException } from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';

export interface WidgetsRepository {
  findOne(id: string): string;
}

// A real implementation exists in the program (and does throw) — proving
// the gap is deliberate interface-typed-dependency handling, not merely
// "no implementation was ever written."
export class WidgetsRepositoryImpl implements WidgetsRepository {
  findOne(id: string): string {
    if (!id) throw new NotFoundException('widget not found');
    return 'widget';
  }
}

@Controller('interface-widgets')
export class InterfaceDependencyController {
  constructor(private readonly widgets: WidgetsRepository) {}

  @Get(':id')
  @ApiOkResponse({ description: 'widget' })
  findOne(id: string): string {
    return this.widgets.findOne(id);
  }
}
