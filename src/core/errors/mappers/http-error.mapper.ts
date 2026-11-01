import { HttpStatus } from '@nestjs/common';
import { codeFromHttpStatus } from '../error-codes.ts';
import type { ProblemFields, ProblemMapper } from '../problem-mapper.ts';

// Express and body-parser throw errors from the http-errors package before a
// request reaches NestJS, e.g. an oversized body. `expose` marks the ones whose
// message is safe to show to the client.
type HttpError = Error & { status: number; expose: boolean };

function isHttpError(exception: unknown): exception is HttpError {
  return (
    exception instanceof Error &&
    'status' in exception &&
    typeof exception.status === 'number' &&
    'expose' in exception &&
    exception.expose === true
  );
}

export class HttpErrorMapper implements ProblemMapper {
  canMap(exception: unknown): exception is HttpError {
    return isHttpError(exception) && exception.status < HttpStatus.INTERNAL_SERVER_ERROR;
  }

  map(exception: HttpError): ProblemFields {
    return { status: exception.status, code: codeFromHttpStatus(exception.status), detail: exception.message };
  }
}
