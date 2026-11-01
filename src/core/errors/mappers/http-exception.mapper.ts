import { HttpException, HttpStatus } from '@nestjs/common';
import { CommonErrorCode, codeFromHttpStatus } from '../error-codes.ts';
import type { ProblemFields, ProblemMapper } from '../problem-mapper.ts';

// NestJS turns the body parser's SyntaxError into a BadRequestException that
// keeps only the message, so the message is the only way to recognise it.
const JSON_PARSE_MESSAGE = /JSON/;

// Errors NestJS and Express throw themselves: unknown route, malformed JSON
// body, oversized body, rate limit (ERR-03). Our own errors are AppErrors.
export class HttpExceptionMapper implements ProblemMapper {
  canMap(exception: unknown): exception is HttpException {
    return exception instanceof HttpException && exception.getStatus() < HttpStatus.INTERNAL_SERVER_ERROR;
  }

  map(exception: HttpException): ProblemFields {
    const status: HttpStatus = exception.getStatus();
    const isMalformedJson = status === HttpStatus.BAD_REQUEST && JSON_PARSE_MESSAGE.test(exception.message);
    return {
      status,
      code: isMalformedJson ? CommonErrorCode.INVALID_JSON : codeFromHttpStatus(status),
      detail: exception.message,
    };
  }
}
