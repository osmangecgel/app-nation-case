import { HttpStatus } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ComponentStatus, HealthStatus } from '#modules/health/health.constants.ts';
import { configureHttp } from '#core/http/configure-http.ts';
import { AppModule } from '../src/app.module.ts';

describe('GET /health', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureHttp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 200 when the database and the cache are reachable', async () => {
    const response = await request(app.getHttpServer()).get('/health').expect(HttpStatus.OK);

    expect(response.body).toEqual({ status: HealthStatus.OK, database: ComponentStatus.UP, cache: ComponentStatus.UP });
  });
});
