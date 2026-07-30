import { Controller, Get } from '@nestjs/common';

const NAME = 'dyn';
const PREFIX = 'constpath';
// eslint has no visibility into fixtures (excluded, see PLAN.md/task brief) —
// this file deliberately exercises non-literal path expressions.
let DYNAMIC = 'initial';
DYNAMIC = DYNAMIC + '!'; // real reassignment — `let`, so its type widens to `string`.

function computePath(): string {
  return 'computed';
}

@Controller('tpl')
export class TemplateController {
  // Resolvable via the checker bonus (core/decorators.ts's
  // `resolveToStringLiteral`): a template literal whose only interpolation
  // is a `const` with a literal type gets a literal template-literal type
  // from the checker itself. → /tpl/dyn/sub, resolved.
  @Get(`${NAME}/sub`)
  templateSub(): string {
    return 'sub';
  }

  // A bare `const` reference — its type is the literal itself. → /tpl/constpath, resolved.
  @Get(PREFIX)
  constRef(): string {
    return 'const';
  }

  // String concatenation of two literals, folded manually (the checker does
  // NOT give `'a' + 'b'` a literal type on its own — verified). → /tpl/ab, resolved.
  @Get('a' + 'b')
  concatenated(): string {
    return 'concat';
  }

  // A `let` that's been reassigned: the checker reports its type as the
  // widened `string`, not a literal — genuinely unresolved.
  @Get(DYNAMIC)
  dynamicLet(): string {
    return 'dynamic';
  }

  // A function call result: never statically resolvable — genuinely unresolved.
  @Get(computePath())
  computedCall(): string {
    return 'computed';
  }

  // Array with one resolvable and one unresolvable element: `paths` keeps
  // what it could resolve, `unresolvedPath` still flags the loss.
  @Get(['ok', DYNAMIC])
  mixedArray(): string {
    return 'mixed';
  }
}
