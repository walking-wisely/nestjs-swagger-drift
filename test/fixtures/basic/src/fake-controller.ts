// A local decorator named `Controller`, unrelated to @nestjs/common.
// Exercises the provenance check in `core/decorators.ts`: the checker
// resolves `Controller` here to *this* declaration, not one under
// `@nestjs/common`, so it must be classified `'mismatch'` and rejected —
// this class must contribute zero handlers to the route table.
function Controller(_path?: string): ClassDecorator {
  return () => undefined;
}

function Get(_path?: string): MethodDecorator {
  return () => undefined;
}

@Controller('imposter')
export class FakeController {
  @Get()
  shouldNotAppear(): string {
    return 'should not be discovered';
  }
}
