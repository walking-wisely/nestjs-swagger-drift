import { Controller, Get } from '@nestjs/common';

// Array-form @Controller path: NestJS registers one route group per prefix.
@Controller(['a', 'b'])
export class MultiPrefixController {
  @Get()
  root(): string {
    return 'root';
  }

  // Array-form @Get path too: combinations multiply, 2 class prefixes x 2
  // method paths = 4 routes.
  @Get(['x', 'y'])
  multi(): string {
    return 'multi';
  }
}

// Object-form @Controller path.
@Controller({ path: 'obj' })
export class ObjectPathController {
  @Get()
  ping(): string {
    return 'ok';
  }
}
