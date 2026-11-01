import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NextFunction, Request, Response } from 'express';
import type { Env } from '#core/config/env.validation.ts';
import { type LoggableBody, RequestContext } from '#core/context/request-context.ts';
import {
  HTTP_LOG_CONTEXT,
  HTTP_LOG_EXCLUDED_PATHS,
  HttpLogEvent,
  MAX_LOGGED_BODY_BYTES,
  MULTIPART_CONTENT_TYPE,
} from './logging.constants.ts';

type BodyFields = { body?: LoggableBody; bodyOmittedBytes?: number };
type RouteFields = { method: string; path: string };

// request.path is relative to the middleware mount point; originalUrl is the
// full URL. The query string is logged separately so the logger can mask it.
function routeOf(request: Request): RouteFields {
  const [path = request.originalUrl] = request.originalUrl.split('?');
  return { method: request.method, path };
}

// LOG-06: one line when a request arrives, one when its response is sent.
// trackResponse runs before the body parser, so requests rejected while the
// body is read (malformed JSON, oversized body) still get a response line.
// use runs after it, so the request line can carry the parsed body.
// Bodies are logged only when LOG_HTTP_BODIES is on; the logger masks them (LOG-07).
@Injectable()
export class HttpLoggingMiddleware implements NestMiddleware {
  private readonly logger = new Logger(HTTP_LOG_CONTEXT);
  private readonly logBodies: boolean;

  constructor(
    config: ConfigService<Env, true>,
    private readonly context: RequestContext,
  ) {
    this.logBodies = config.get('LOG_HTTP_BODIES', { infer: true });
  }

  trackResponse(request: Request, response: Response, next: NextFunction): void {
    const route = routeOf(request);
    if (HTTP_LOG_EXCLUDED_PATHS.has(route.path)) {
      next();
      return;
    }
    const startedAt = performance.now();
    // 'close' fires both after a complete response and when the client
    // disconnects early; 'finish' would miss the second case.
    response.on(
      'close',
      this.context.bind(() => {
        const durationMs = Math.round(performance.now() - startedAt);
        if (!response.writableFinished) {
          this.logger.log(HttpLogEvent.REQUEST_ABORTED, { ...route, durationMs });
          return;
        }
        this.logger.log(HttpLogEvent.RESPONSE_SENT, {
          ...route,
          status: response.statusCode,
          durationMs,
          ...this.bodyFields(this.context.responseBody()),
        });
      }),
    );
    next();
  }

  use(request: Request, _response: Response, next: NextFunction): void {
    const route = routeOf(request);
    if (!HTTP_LOG_EXCLUDED_PATHS.has(route.path)) {
      const query = Object.keys(request.query).length > 0 ? { query: request.query } : {};
      this.logger.log(HttpLogEvent.REQUEST_RECEIVED, { ...route, ...query, ...this.requestBodyFields(request) });
    }
    next();
  }

  private requestBodyFields(request: Request): BodyFields {
    const isMultipart = typeof request.is(MULTIPART_CONTENT_TYPE) === 'string';
    return isMultipart ? {} : this.bodyFields(request.body);
  }

  // Oversized bodies are omitted rather than cut: a cut JSON string could no
  // longer be masked field by field.
  private bodyFields(body: LoggableBody | undefined): BodyFields {
    if (!this.logBodies || body === undefined) {
      return {};
    }
    const size = Buffer.byteLength(JSON.stringify(body));
    return size > MAX_LOGGED_BODY_BYTES ? { bodyOmittedBytes: size } : { body };
  }
}
