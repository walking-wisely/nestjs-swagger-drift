// Guards against false positives on shorthand `@Api*Response` decorators
// beyond the common four (`Ok`/`Created`/`NotFound`/`BadRequest`) —
// adversarial review found live false positives on exactly these three,
// presumably because they're less commonly hand-rolled into test doubles
// and easy to miss when wiring up the shorthand table.
import {
  Controller,
  Post,
  PreconditionFailedException,
  ImATeapotException,
  HttpVersionNotSupportedException,
} from '@nestjs/common';
import {
  ApiPreconditionFailedResponse,
  ApiIAmATeapotResponse,
  ApiHttpVersionNotSupportedResponse,
  ApiCreatedResponse,
} from '@nestjs/swagger';

@Controller('uncommon-shorthands')
export class UncommonShorthandsController {
  @Post('precondition')
  @ApiCreatedResponse({ description: 'created' })
  @ApiPreconditionFailedResponse({ description: 'precondition failed' })
  precondition(): string {
    throw new PreconditionFailedException('precondition failed');
  }

  @Post('teapot')
  @ApiCreatedResponse({ description: 'created' })
  @ApiIAmATeapotResponse({ description: "I'm a teapot" })
  teapot(): string {
    throw new ImATeapotException("I'm a teapot");
  }

  @Post('http-version')
  @ApiCreatedResponse({ description: 'created' })
  @ApiHttpVersionNotSupportedResponse({ description: 'http version not supported' })
  httpVersion(): string {
    throw new HttpVersionNotSupportedException('http version not supported');
  }
}
