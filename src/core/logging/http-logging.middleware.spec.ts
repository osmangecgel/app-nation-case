import { EventEmitter } from 'node:events';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { Request, Response } from 'express';
import { RequestContext } from '#core/context/request-context.ts';
import { HttpLoggingMiddleware } from './http-logging.middleware.ts';
import { HttpLogEvent, MAX_LOGGED_BODY_BYTES, MULTIPART_CONTENT_TYPE } from './logging.constants.ts';

const REQUEST_ID = '4bf92f3577b34da6a3ce929d0e0e4736';

class FakeResponse extends EventEmitter {
  statusCode = 200;
  writableFinished = false;
}

type FakeRequestOptions = { url?: string; body?: object; query?: object; contentType?: string };

async function createMiddleware(
  logBodies: boolean,
): Promise<{ middleware: HttpLoggingMiddleware; context: RequestContext }> {
  const moduleRef = await Test.createTestingModule({
    providers: [
      HttpLoggingMiddleware,
      RequestContext,
      { provide: ConfigService, useValue: { get: vi.fn().mockReturnValue(logBodies) } },
    ],
  }).compile();
  return { middleware: moduleRef.get(HttpLoggingMiddleware), context: moduleRef.get(RequestContext) };
}

function fakeRequest({
  url = '/v1/orders',
  body,
  query = {},
  contentType = 'application/json',
}: FakeRequestOptions = {}): Request {
  return Object.assign(new EventEmitter(), {
    method: 'POST',
    originalUrl: url,
    body,
    query,
    is: (type: string) => (type === contentType ? type : false),
  }) as never;
}

describe('HttpLoggingMiddleware', () => {
  const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

  beforeEach(() => log.mockClear());

  describe('trackResponse (registered before the body parser)', () => {
    it('logs the response once it has been sent', async () => {
      const { middleware } = await createMiddleware(false);
      const response = new FakeResponse();

      middleware.trackResponse(fakeRequest(), response as never as Response, vi.fn());
      response.writableFinished = true;
      response.emit('close');

      expect(log).toHaveBeenLastCalledWith(
        HttpLogEvent.RESPONSE_SENT,
        expect.objectContaining({ method: 'POST', path: '/v1/orders', status: 200 }),
      );
    });

    it('logs an aborted request when the client disconnects before the response', async () => {
      const { middleware } = await createMiddleware(false);
      const response = new FakeResponse();

      middleware.trackResponse(fakeRequest(), response as never as Response, vi.fn());
      response.emit('close');

      expect(log).toHaveBeenLastCalledWith(
        HttpLogEvent.REQUEST_ABORTED,
        expect.objectContaining({ method: 'POST', path: '/v1/orders', durationMs: expect.any(Number) }),
      );
    });

    it('keeps the request request id for the response line, even when the event fires outside the request', async () => {
      const { middleware, context } = await createMiddleware(false);
      const response = new FakeResponse();
      let requestIdAtLog: string | undefined;
      log.mockImplementationOnce(() => {
        requestIdAtLog = context.requestId();
      });

      context.run({ requestId: REQUEST_ID }, () =>
        middleware.trackResponse(fakeRequest(), response as never as Response, vi.fn()),
      );
      response.writableFinished = true;
      response.emit('close');

      expect(requestIdAtLog).toBe(REQUEST_ID);
    });

    it('does not track /health requests', async () => {
      const { middleware } = await createMiddleware(true);
      const response = new FakeResponse();
      const next = vi.fn();

      middleware.trackResponse(fakeRequest({ url: '/health?probe=1' }), response as never as Response, next);
      response.writableFinished = true;
      response.emit('close');

      expect(log).not.toHaveBeenCalledWith(HttpLogEvent.RESPONSE_SENT, expect.anything());
      expect(next).toHaveBeenCalled();
    });
  });

  describe('use (runs after the body parser)', () => {
    it('logs the path without the query string and the query as a separate field (LOG-07)', async () => {
      const { middleware } = await createMiddleware(false);

      middleware.use(
        fakeRequest({ url: '/v1/orders?token=abc&page=2', query: { token: 'abc', page: '2' } }),
        new FakeResponse() as never as Response,
        vi.fn(),
      );

      expect(log).toHaveBeenCalledWith(
        HttpLogEvent.REQUEST_RECEIVED,
        // The query object goes through the logger's masking like any other field.
        expect.objectContaining({ path: '/v1/orders', query: { token: 'abc', page: '2' } }),
      );
    });

    it('adds the request body when LOG_HTTP_BODIES is on', async () => {
      const { middleware } = await createMiddleware(true);

      middleware.use(fakeRequest({ body: { name: 'Desk lamp' } }), new FakeResponse() as never as Response, vi.fn());

      expect(log).toHaveBeenCalledWith(
        HttpLogEvent.REQUEST_RECEIVED,
        expect.objectContaining({ body: { name: 'Desk lamp' } }),
      );
    });

    it('replaces an oversized body with its size', async () => {
      const { middleware } = await createMiddleware(true);
      const body = { note: 'x'.repeat(MAX_LOGGED_BODY_BYTES) };

      middleware.use(fakeRequest({ body }), new FakeResponse() as never as Response, vi.fn());

      expect(log).toHaveBeenCalledWith(
        HttpLogEvent.REQUEST_RECEIVED,
        expect.objectContaining({ bodyOmittedBytes: expect.any(Number) }),
      );
      expect(log.mock.lastCall?.[1]).not.toHaveProperty('body');
    });

    it('never logs the body of a file upload', async () => {
      const { middleware } = await createMiddleware(true);
      const request = fakeRequest({ body: { file: 'binary' }, contentType: MULTIPART_CONTENT_TYPE });

      middleware.use(request, new FakeResponse() as never as Response, vi.fn());

      expect(log.mock.lastCall?.[1]).not.toHaveProperty('body');
    });

    it('does not log /health requests', async () => {
      const { middleware } = await createMiddleware(true);
      const next = vi.fn();

      middleware.use(fakeRequest({ url: '/health' }), new FakeResponse() as never as Response, next);

      expect(log).not.toHaveBeenCalledWith(HttpLogEvent.REQUEST_RECEIVED, expect.anything());
      expect(next).toHaveBeenCalled();
    });
  });
});
