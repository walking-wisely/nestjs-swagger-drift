// Existing `@nestjs/swagger` import is a NAMESPACE import
// (`import * as swagger from '@nestjs/swagger'`). ts-morph throws
// `InvalidOperationError` if `addNamedImports` is called on a declaration
// that itself has a namespace import — autofix must add a SEPARATE named
// import declaration alongside it (legal: namespace + named imports from
// the same module in different declarations) rather than mutate this one.
import { Controller, Get, NotFoundException } from '@nestjs/common';
import * as swagger from '@nestjs/swagger';

@swagger.ApiTags('namespace')
@Controller('namespace')
export class NamespaceImportController {
  @Get(':id')
  findOne(): string {
    throw new NotFoundException('widget not found');
  }
}
