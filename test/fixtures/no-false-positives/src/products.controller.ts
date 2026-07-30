// PLAN §7's "no false positives" corpus: a correctly documented controller.
// The regression net — this must always produce zero findings.
import {
  Controller,
  Get,
  Post,
  Delete,
  BadRequestException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import {
  ApiOkResponse,
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiConflictResponse,
} from '@nestjs/swagger';

@Controller('products')
export class ProductsController {
  @Get()
  @ApiOkResponse({ description: 'list of products' })
  findAll(): string[] {
    return ['widget'];
  }

  @Get(':id')
  @ApiOkResponse({ description: 'a product' })
  @ApiNotFoundResponse({ description: 'no such product' })
  findOne(id: string): string {
    if (!id) throw new NotFoundException('product not found');
    return 'widget';
  }

  @Post()
  @ApiBadRequestResponse({ status: 400, description: 'invalid payload' })
  @ApiNotFoundResponse({ description: 'related resource missing' })
  create(name: string): string {
    if (!name) throw new BadRequestException('name required');
    throw new NotFoundException('related resource missing');
  }

  @Delete(':id')
  @ApiOkResponse({ description: 'deleted' })
  remove(): void {
    // No throws at all — nothing to document beyond success.
  }
}

// Exercises class-level documentation covering a throw the method itself
// doesn't mention.
@Controller('orders')
@ApiConflictResponse({ description: 'duplicate order' })
export class OrdersController {
  @Post()
  create(): string {
    throw new ConflictException('duplicate order');
  }
}
