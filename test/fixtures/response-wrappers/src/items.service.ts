import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';

@Injectable()
export class ItemsService {
  find(id: string): string {
    if (!id) throw new NotFoundException('missing');
    return id;
  }

  create(name: string): string {
    if (name === 'taken') throw new ConflictException('taken');
    return name;
  }
}
