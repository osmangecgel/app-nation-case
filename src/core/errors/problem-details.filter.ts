import { type ArgumentsHost, Catch, type ExceptionFilter, HttpStatus, Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { STATUS_CODES } from 'node:http';
import type { Env } from '#core/config/env.validation.ts';
import { RequestContext } from '#core/context/request-context.ts';
import { TooManyRequestsError } from './app-errors.ts';
import { CommonErrorCode } from './error-codes.ts';
import { PROBLEM_MAPPERS, type ProblemFields, type ProblemMapper } from './problem-mapper.ts';

const PROBLEM_CONTENT_TYPE = 'application/problem+json';
const ProblemLogEvent = {
  REQUEST_FAILED: 'REQUEST_FAILED',
  REQUEST_REJECTED: 'REQUEST_REJECTED',
} as const;
const UNEXPECTED_ERROR: ProblemFields = {
  status: HttpStatus.INTERNAL_SERVER_ERROR,
  code: CommonErrorCode.INTERNAL_ERROR,
  detail: 'An unexpected error occurred.',
};

type ProblemDetails = ProblemFields & {
  title: string;
  instance: string;
  error: string;
  requestId?: string;
  stack?: string;
};

// Turns every error into an RFC 9457 response (ERR-01). Errors no mapper
// recognises are unexpected: 500 with a fixed detail, full error in the log (ERR-05).
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);
  private readonly includeStack: boolean;

  constructor(
    @Inject(PROBLEM_MAPPERS) private readonly mappers: ProblemMapper[],
    private readonly context: RequestContext,
    config: ConfigService<Env, true>,
  ) {
    this.includeStack = config.get('ERROR_INCLUDE_STACK', { infer: true });
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const fields = this.mappers.find((mapper) => mapper.canMap(exception))?.map(exception) ?? UNEXPECTED_ERROR;
    const problem = this.toProblem(fields, request, exception);

    this.log(problem, exception);
    this.context.setResponseBody(problem);
    if (exception instanceof TooManyRequestsError && exception.retryAfterSeconds !== undefined) {
      response.setHeader('Retry-After', String(exception.retryAfterSeconds));
    }
    response.status(problem.status).type(PROBLEM_CONTENT_TYPE).json(problem);
  }

  private toProblem(fields: ProblemFields, request: Request, exception: unknown): ProblemDetails {
    const problem: ProblemDetails = {
      title: STATUS_CODES[fields.status] ?? CommonErrorCode.INTERNAL_ERROR,
      status: fields.status,
      detail: fields.detail,
      instance: request.path,
      code: fields.code,
      // Clients that expect { error: 'insufficient_credits' } read this field (ERR-01).
      error: fields.code.toLowerCase(),
      requestId: this.context.requestId(),
      ...(fields.errors ? { errors: fields.errors } : {}),
    };
    return this.includeStack && exception instanceof Error ? { ...problem, stack: exception.stack } : problem;
  }

  // LOG-05: 5xx is an error with its stack, 4xx is the client's mistake and only a warning.
  private log(problem: ProblemDetails, exception: unknown): void {
    const fields = { code: problem.code, status: problem.status };
    if (problem.status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      const stack = exception instanceof Error ? exception.stack : String(exception);
      this.logger.error(ProblemLogEvent.REQUEST_FAILED, fields, stack);
      return;
    }
    this.logger.warn(ProblemLogEvent.REQUEST_REJECTED, fields);
  }
}
