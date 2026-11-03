import { Controller, Get, Post } from '@nestjs/common';
import { ApiExcludeController, ApiExcludeEndpoint } from '@nestjs/swagger';

@ApiExcludeController()
@Controller('hidden')
export class HiddenController {
  @Post()
  create(): string {
    return 'created';
  }
}

@ApiExcludeController(false)
@Controller('shown')
export class ShownController {
  @Get()
  list(): string {
    return 'ok';
  }
}

@Controller('mixed')
export class MixedController {
  @ApiExcludeEndpoint()
  @Get('internal')
  internal(): string {
    return 'ok';
  }

  @Get('public')
  list(): string {
    return 'ok';
  }
}
