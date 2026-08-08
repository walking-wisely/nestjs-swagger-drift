import { ConflictException, Injectable } from '@nestjs/common';

@Injectable()
export class ExistingImportService {
  update(): void {
    throw new ConflictException('already exists');
  }
}
