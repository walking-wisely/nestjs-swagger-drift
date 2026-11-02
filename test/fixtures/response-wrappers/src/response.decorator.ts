import { applyDecorators } from '@nestjs/common';
import { ApiConflictResponse, ApiCreatedResponse } from '@nestjs/swagger';
import type { ApiResponseOptions } from '@nestjs/swagger';

type Factory = (options?: ApiResponseOptions) => MethodDecorator & ClassDecorator;

declare const customResponseDecorators: Record<string, Factory>;

export const { ApiOkResponse }: { ApiOkResponse: Factory } = customResponseDecorators;
export const { ApiNotFoundResponse }: { ApiNotFoundResponse: Factory } = customResponseDecorators;

export const ApiResponse = (_dto: unknown, statusCode: number = 200) => {
  let decorator: Factory;
  switch (statusCode) {
    case 201:
      decorator = ApiCreatedResponse;
      break;
    case 404:
      decorator = ApiNotFoundResponse;
      break;
    case 409:
      decorator = ApiConflictResponse;
      break;
    default:
      decorator = ApiOkResponse;
      break;
  }
  return applyDecorators(decorator({ description: 'documented' }));
};

export const ApiCommonResponses = () => {
  const decorators: Array<MethodDecorator & ClassDecorator> = [];
  for (const name of ['ApiNotFoundResponse', 'ApiConflictResponse']) {
    decorators.push(customResponseDecorators[name]!());
  }
  return applyDecorators(...decorators);
};
