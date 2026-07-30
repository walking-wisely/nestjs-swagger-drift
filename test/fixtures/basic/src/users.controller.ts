import { Controller, Get, Post, Put, Delete, Injectable } from '@nestjs/common';

@Controller('users')
export class UsersController {
  @Get()
  findAll(): string {
    return 'all users';
  }

  @Get(':id')
  findOne(): string {
    return 'one user';
  }

  @Post()
  create(): string {
    return 'created';
  }

  @Put(':id')
  update(): string {
    return 'updated';
  }

  @Delete(':id')
  remove(): string {
    return 'removed';
  }
}

// Not a controller — no @Controller decorator. Discovery must ignore this
// class entirely, even though it lives in the same file as a real one and
// has method names that shadow HTTP verbs.
@Injectable()
export class UsersService {
  findAll(): string {
    return 'service all users';
  }

  get(): string {
    return 'not a route';
  }
}
