import { Controller, Get, Post } from '@nestjs/common';

@Controller('orders')
export class OrdersController {
  @Get()
  findAll(): string {
    return 'all orders';
  }

  @Get(':id')
  findOne(): string {
    return 'one order';
  }

  // One method, two HTTP-method decorators — NestJS registers this as two
  // independent routes, so discovery must yield two HandlerInfos.
  @Get('ping')
  @Post('ping')
  ping(): string {
    return 'pong';
  }
}
