import { Controller, Get, HttpStatus } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { getOptionsToken, type ThrottlerModuleOptions } from '@nestjs/throttler';
import request from 'supertest';
import { configureHttp } from '#core/http/configure-http.ts';
import { RedisThrottlerStorage } from '#infra/cache/redis-throttler.storage.ts';
import { AppModule } from '../src/app.module.ts';

const TEST_LIMIT = 3;

@Controller('rate-probe')
class RateProbeController {
  @Get()
  ping(): { ok: boolean } {
    return { ok: true };
  }

  @Get('spoof')
  spoof(): { ok: boolean } {
    return { ok: true };
  }
}

describe('Rate limiting (API-09)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [RateProbeController],
    })
      .overrideProvider(getOptionsToken())
      .useFactory({
        factory: (storage: RedisThrottlerStorage): ThrottlerModuleOptions => ({
          throttlers: [{ ttl: 60_000, limit: TEST_LIMIT }],
          storage,
        }),
        inject: [RedisThrottlerStorage],
      })
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureHttp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects requests over the limit with 429, Retry-After and a problem body', async () => {
    for (let attempt = 0; attempt < TEST_LIMIT; attempt += 1) {
      await request(app.getHttpServer()).get('/v1/rate-probe').expect(HttpStatus.OK);
    }

    const response = await request(app.getHttpServer())
      .get('/v1/rate-probe')
      .expect(HttpStatus.TOO_MANY_REQUESTS)
      .expect('content-type', /application\/problem\+json/);

    expect(response.headers['retry-after']).toMatch(/^\d+$/);
    expect(response.body.code).toBe('TOO_MANY_REQUESTS');
  });

  it('ignores a client-supplied X-Forwarded-For header when no proxy is trusted', async () => {
    // Each request claims a different IP; if the header were trusted, none would share a counter.
    for (let attempt = 0; attempt < TEST_LIMIT; attempt += 1) {
      await request(app.getHttpServer()).get('/v1/rate-probe/spoof').set('x-forwarded-for', `203.0.113.${attempt}`);
    }

    await request(app.getHttpServer())
      .get('/v1/rate-probe/spoof')
      .set('x-forwarded-for', '203.0.113.99')
      .expect(HttpStatus.TOO_MANY_REQUESTS);
  });

  it('does not limit /health', async () => {
    for (let attempt = 0; attempt <= TEST_LIMIT + 1; attempt += 1) {
      await request(app.getHttpServer()).get('/health').expect(HttpStatus.OK);
    }
  });
});
