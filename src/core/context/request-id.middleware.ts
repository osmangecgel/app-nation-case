import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { REQUEST_ID_HEADER, TRACEPARENT_HEADER } from './context.constants.ts';
import { RequestContext } from './request-context.ts';
import { generateRequestId, requestIdFromTraceparent } from './request-id.ts';

// LOG-01: every request gets an id, taken from traceparent when present. It is
// on every log line of the request, in the x-request-id response header and in
// error responses, and it follows the job to the worker.
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  constructor(private readonly context: RequestContext) {}

  use(request: Request, response: Response, next: NextFunction): void {
    const requestId = requestIdFromTraceparent(request.header(TRACEPARENT_HEADER)) ?? generateRequestId();
    response.setHeader(REQUEST_ID_HEADER, requestId);
    this.context.run({ requestId }, next);
  }
}
