import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common';
import { type Observable, tap } from 'rxjs';
import { type LoggableBody, RequestContext } from '#core/context/request-context.ts';

// Hands successful response bodies to HttpLoggingMiddleware (LOG-06).
// Error bodies are recorded by the exception filter.
@Injectable()
export class ResponseBodyInterceptor implements NestInterceptor<LoggableBody, LoggableBody> {
  constructor(private readonly context: RequestContext) {}

  intercept(_execution: ExecutionContext, next: CallHandler<LoggableBody>): Observable<LoggableBody> {
    return next.handle().pipe(tap((body) => this.context.setResponseBody(body)));
  }
}
