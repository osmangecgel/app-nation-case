import { applyDecorators, HttpStatus } from '@nestjs/common';
import { ApiBody, ApiExtension, ApiOperation, ApiParam, ApiQuery, ApiResponse } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { STATUS_CODES } from 'node:http';
import type { z } from 'zod';
import { CommonErrorCode } from '#core/errors/error-codes.ts';
import { ProblemDetailsSchema } from '#core/errors/problem-details.schema.ts';
import { DOCUMENTED_EXTENSION } from './openapi.constants.ts';
import { toOpenApiParameters, toOpenApiSchema } from './zod-openapi.ts';

// Error bodies are sent as RFC 9457 problem documents (ERR-01).
const PROBLEM_CONTENT_TYPE = 'application/problem+json';

type ResponseDoc = { status: HttpStatus; schema?: z.ZodType; description?: string };
type ErrorDoc = { status: HttpStatus; code: string };

export type ApiEndpointOptions = {
  summary: string;
  description?: string;
  params?: z.ZodObject;
  // The path parameters take any value: the service answers a malformed id
  // with 404, as it does for a missing one, so no 400 is documented for them.
  paramsTakeAnyValue?: boolean;
  query?: z.ZodObject;
  body?: z.ZodType;
  response: ResponseDoc | ResponseDoc[];
  errors?: ErrorDoc[];
  // false also turns the rate limit off for the endpoint, so docs and behaviour match (API-09).
  rateLimited?: boolean;
};

function automaticErrors(options: ApiEndpointOptions): ErrorDoc[] {
  const validatedParams = options.params !== undefined && options.paramsTakeAnyValue !== true;
  const hasInput = validatedParams || options.query !== undefined || options.body !== undefined;
  const bodyErrors = options.body
    ? [
        { status: HttpStatus.BAD_REQUEST, code: CommonErrorCode.INVALID_JSON },
        { status: HttpStatus.PAYLOAD_TOO_LARGE, code: CommonErrorCode.PAYLOAD_TOO_LARGE },
      ]
    : [];
  return [
    ...(hasInput ? [{ status: HttpStatus.BAD_REQUEST, code: CommonErrorCode.VALIDATION_FAILED }] : []),
    ...bodyErrors,
    ...(options.rateLimited === false
      ? []
      : [{ status: HttpStatus.TOO_MANY_REQUESTS, code: CommonErrorCode.TOO_MANY_REQUESTS }]),
    { status: HttpStatus.INTERNAL_SERVER_ERROR, code: CommonErrorCode.INTERNAL_ERROR },
  ];
}

// One response per status; its description lists every error code it can carry (DOC-04).
function errorResponses(errors: ErrorDoc[]): MethodDecorator[] {
  const codesByStatus = new Map<HttpStatus, string[]>();
  for (const { status, code } of errors) {
    codesByStatus.set(status, [...(codesByStatus.get(status) ?? []), code]);
  }
  const problemSchema = toOpenApiSchema(ProblemDetailsSchema);
  return [...codesByStatus].map(([status, codes]) =>
    ApiResponse({
      status,
      description: `Error codes: ${codes.join(', ')}.`,
      content: { [PROBLEM_CONTENT_TYPE]: { schema: problemSchema } },
    }),
  );
}

function successResponses(response: ApiEndpointOptions['response']): MethodDecorator[] {
  return [response].flat().map(({ status, schema, description }) =>
    ApiResponse({
      status,
      description: description ?? STATUS_CODES[status] ?? '',
      ...(schema ? { schema: toOpenApiSchema(schema) } : {}),
    }),
  );
}

function inputDecorators({ params, query, body }: ApiEndpointOptions): MethodDecorator[] {
  return [
    ...(params ? toOpenApiParameters(params, 'input').map((parameter) => ApiParam(parameter)) : []),
    ...(query ? toOpenApiParameters(query, 'input').map((parameter) => ApiQuery(parameter)) : []),
    ...(body ? [ApiBody({ schema: toOpenApiSchema(body, 'input') })] : []),
  ];
}

// Documents an endpoint from the same zod schemas used for validation
// (API_DOCUMENTATION_STANDARDS.md, DOC-01 to DOC-04).
export function ApiEndpoint(options: ApiEndpointOptions): MethodDecorator {
  return applyDecorators(
    ApiOperation({ summary: options.summary, description: options.description }),
    ApiExtension(DOCUMENTED_EXTENSION, true),
    ...inputDecorators(options),
    ...successResponses(options.response),
    ...errorResponses([...(options.errors ?? []), ...automaticErrors(options)]),
    ...(options.rateLimited === false ? [SkipThrottle()] : []),
  );
}
