// Tab-indented (unlike every other fixture file here, deliberately) with a
// trailing line comment on the LAST existing decorator — two real bugs found
// running Tier 1 autofix against Ever Gauzy (PLAN §10.0): (1) a hardcoded
// two-space `IndentationText` put spaces next to tabs on the inserted line,
// and (2) appending a decorator (`addDecorator`) reassociated this trailing
// comment with the NEW decorator instead of leaving it on `@Get`.
import { Controller, Get, NotFoundException } from '@nestjs/common';

@Controller('tabbed')
export class TabIndentedController {
	@Get(':id') // fetch one
	findOne(): string {
		throw new NotFoundException('not found');
	}
}
