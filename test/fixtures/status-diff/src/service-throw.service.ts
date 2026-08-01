// PLAN §4.1b: a throw one hop away from the handler, inside an injected
// service — the real-world shape the call graph exists for (measured on a
// real NestJS repo: 79/80 throws live in services, not controllers).
import { Injectable, NotFoundException } from '@nestjs/common';

@Injectable()
export class WidgetsService {
  findOne(id: string): string {
    if (!id) throw new NotFoundException('widget not found in service');
    return 'widget';
  }
}
