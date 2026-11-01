import { Body, Controller, Get, HttpStatus, Logger, Post } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { z } from 'zod';
import { BusinessRuleError, NotFoundError } from '#core/errors/app-errors.ts';
import { ZodValidationPipe } from '#core/validation/zod-validation.pipe.ts';
import { configureHttp } from '#core/http/configure-http.ts';
import { AppModule } from '../src/app.module.ts';

const ProbeSchema = z.strictObject({ name: z.string() });
type ProbeDto = z.infer<typeof ProbeSchema>;

@Controller('probe')
class ProbeController {
  @Post()
  create(@Body(new ZodValidationPipe(ProbeSchema)) dto: ProbeDto): ProbeDto {
    return dto;
  }

  @Get('missing')
  missing(): never {
    throw new NotFoundError('PROBE_NOT_FOUND', 'Probe was not found.');
  }

  @Get('rule')
  rule(): never {
    throw new BusinessRuleError('PROBE_LOCKED', 'Probe is locked.');
  }

  @Get('crash')
  crash(): never {
    throw new Error('connection to 10.0.0.5 refused');
  }
}

const PROBLEM_CONTENT_TYPE = /application\/problem\+json/;
const REQUEST_ID = /^[0-9a-f]{32}$/;

describe('Error responses (RFC 9457)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [ProbeController],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureHttp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns field errors when validation fails', async () => {
    const response = await request(app.getHttpServer())
      .post('/v1/probe')
      .send({ extra: true })
      .expect(HttpStatus.BAD_REQUEST)
      .expect('content-type', PROBLEM_CONTENT_TYPE);

    expect(response.body).toEqual({
      title: 'Bad Request',
      status: HttpStatus.BAD_REQUEST,
      detail: '2 fields are invalid.',
      instance: '/v1/probe',
      code: 'VALIDATION_FAILED',
      error: 'validation_failed',
      requestId: expect.stringMatching(REQUEST_ID),
      errors: [
        { field: 'name', code: 'REQUIRED', message: 'Field is required.' },
        { field: 'extra', code: 'UNKNOWN_FIELD', message: expect.any(String) },
      ],
    });
  });

  it('returns INVALID_JSON for a malformed body', async () => {
    const response = await request(app.getHttpServer())
      .post('/v1/probe')
      .set('content-type', 'application/json')
      .send('{"name":')
      .expect(HttpStatus.BAD_REQUEST);

    expect(response.body.code).toBe('INVALID_JSON');
  });

  it('gives a malformed body a request id like any other request (LOG-01, ERR-01)', async () => {
    const response = await request(app.getHttpServer())
      .post('/v1/probe')
      .set('content-type', 'application/json')
      .send('{"name":')
      .expect('content-type', PROBLEM_CONTENT_TYPE);

    expect(response.headers['x-request-id']).toMatch(REQUEST_ID);
    expect(response.body.requestId).toBe(response.headers['x-request-id']);
  });

  it('returns 413 PAYLOAD_TOO_LARGE for an oversized body', async () => {
    const response = await request(app.getHttpServer())
      .post('/v1/probe')
      .send({ name: 'x'.repeat(300 * 1024) })
      .expect(HttpStatus.PAYLOAD_TOO_LARGE);

    expect(response.body).toEqual(
      expect.objectContaining({
        code: 'PAYLOAD_TOO_LARGE',
        requestId: expect.stringMatching(REQUEST_ID),
      }),
    );
  });

  it('returns 404 with the module error code for a missing record', async () => {
    const response = await request(app.getHttpServer()).get('/v1/probe/missing').expect(HttpStatus.NOT_FOUND);

    expect(response.body).toEqual(expect.objectContaining({ code: 'PROBE_NOT_FOUND', detail: 'Probe was not found.' }));
  });

  it('returns 422 with the module error code for a broken business rule', async () => {
    const response = await request(app.getHttpServer()).get('/v1/probe/rule').expect(HttpStatus.UNPROCESSABLE_ENTITY);

    expect(response.body).toEqual(expect.objectContaining({ code: 'PROBE_LOCKED', title: 'Unprocessable Entity' }));
  });

  it('hides internal details of unexpected errors from the client and logs them (ERR-05)', async () => {
    const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const response = await request(app.getHttpServer()).get('/v1/probe/crash').expect(HttpStatus.INTERNAL_SERVER_ERROR);

    expect(response.body).toEqual(
      expect.objectContaining({ code: 'INTERNAL_ERROR', detail: 'An unexpected error occurred.' }),
    );
    expect(JSON.stringify(response.body)).not.toContain('10.0.0.5');
    expect(logged).toHaveBeenCalledWith(
      'REQUEST_FAILED',
      expect.objectContaining({ code: 'INTERNAL_ERROR' }),
      expect.stringContaining('connection to 10.0.0.5 refused'),
    );
    logged.mockRestore();
  });

  it('serves unversioned paths only for version-neutral routes (API-06)', async () => {
    await request(app.getHttpServer()).get('/probe/missing').expect(HttpStatus.NOT_FOUND);
  });

  it('returns NOT_FOUND for an unknown route', async () => {
    const response = await request(app.getHttpServer()).get('/does-not-exist').expect(HttpStatus.NOT_FOUND);

    expect(response.body.code).toBe('NOT_FOUND');
  });

  it('echoes the request id of an incoming traceparent header (LOG-01)', async () => {
    const requestId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const response = await request(app.getHttpServer())
      .get('/v1/probe/missing')
      .set('traceparent', `00-${requestId}-00f067aa0ba902b7-01`);

    expect(response.headers['x-request-id']).toBe(requestId);
    expect(response.body.requestId).toBe(requestId);
  });
});
