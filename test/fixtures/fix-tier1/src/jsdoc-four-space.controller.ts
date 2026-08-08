// Four-space-indented file with a JSDoc block comment above the class.
// Every `* ...` continuation line has exactly ONE leading space before the
// `*`, which the naive indentation heuristic (`/^( +)\S/` over every line)
// counts as a "1-space indent" and lets it win against the file's real
// 4-space body indentation — regression coverage for that bug (PR #21
// review, Issue 5).
import { Controller, Get, NotFoundException } from '@nestjs/common';

/**
 * Widgets controller.
 * @remarks Something.
 */
@Controller('jsdoc-widgets')
export class JsdocFourSpaceController {
    @Get(':id')
    findOne(): string {
        throw new NotFoundException('widget not found');
    }
}
