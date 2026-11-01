import { type INestApplication, Logger, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import type { Env } from '#core/config/env.validation.ts';
import { RequestIdMiddleware } from '#core/context/request-id.middleware.ts';
import { HttpLoggingMiddleware } from '#core/logging/http-logging.middleware.ts';
import { createOpenApiDocument, setupApiDocs } from './openapi/openapi.ts';

export const DEFAULT_API_VERSION = '1';
const UNDOCUMENTED_LOG_EVENT = 'UNDOCUMENTED_ENDPOINTS';

// SEC-08: the largest valid request is POST /v1/jobs with a 20,000-character
// input. Clients that escape every non-ASCII character (Python's json.dumps
// default) send a letter as \uXXXX (6 bytes) and a character outside the
// Basic Multilingual Plane, such as an emoji, as a surrogate pair (12 bytes):
// up to about 240 KB, far above Express's 100 KB default.
const JSON_BODY_LIMIT = '256kb';

// API-06: every route lives under /v1 unless its controller is VERSION_NEUTRAL.
// Also used by the OpenAPI generator, which runs without providers.
export function configureVersioning(app: INestApplication): void {
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: DEFAULT_API_VERSION });
}

// NestJS adds its body parser when the app initialises; middleware registered
// here, before init, runs ahead of it. Requests rejected while their body is
// read (malformed JSON, oversized body) therefore still get a request id and a
// response log line (LOG-01, LOG-06).
function registerBeforeBodyParser(app: NestExpressApplication): void {
  const requestId = app.get(RequestIdMiddleware);
  const httpLogging = app.get(HttpLoggingMiddleware);
  app.use((request: Request, response: Response, next: NextFunction) => requestId.use(request, response, next));
  app.use((request: Request, response: Response, next: NextFunction) =>
    httpLogging.trackResponse(request, response, next),
  );
}

// HTTP settings shared by main.ts and the e2e tests, so tests run against the
// same routes as the real application.
export function configureHttp(app: NestExpressApplication): void {
  const config = app.get(ConfigService<Env, true>);
  registerBeforeBodyParser(app);
  // Registered after the middleware above, so it still runs ahead of the parser.
  app.useBodyParser('json', { limit: JSON_BODY_LIMIT });
  configureVersioning(app);
  // API-09: behind N proxies, the client IP comes from X-Forwarded-For. With 0
  // the header is ignored, so clients cannot spoof it to dodge the rate limit.
  app.set('trust proxy', config.get('TRUST_PROXY_HOPS', { infer: true }));

  const { document, undocumented } = createOpenApiDocument(app);
  if (undocumented.length > 0) {
    // npm run docs:check fails on these; at runtime a warning is enough.
    new Logger('OpenAPI').warn(UNDOCUMENTED_LOG_EVENT, { endpoints: undocumented });
  }
  setupApiDocs(app, document);
}
