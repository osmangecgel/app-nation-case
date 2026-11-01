import { type BeforeApplicationShutdown, Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { CacheService } from '#infra/cache/cache.service.ts';
import { PrismaService } from '#infra/database/prisma.service.ts';
import { AppModule } from '../src/app.module.ts';

const DOMAIN = 'shutdown_test';

// Stands in for the worker's job consumer: work still running when shutdown
// starts, which finishes during the grace period (beforeApplicationShutdown)
// and writes its outcome to the database and the cache Redis.
@Injectable()
class GracePeriodWork implements BeforeApplicationShutdown {
  outcome?: { cached: string | null; database: number };

  constructor(
    private readonly cache: CacheService,
    private readonly prisma: PrismaService,
  ) {}

  async beforeApplicationShutdown(): Promise<void> {
    await this.cache.set(DOMAIN, 'result', 'stored', 60);
    const [row] = await this.prisma.$queryRaw<{ one: number }[]>`SELECT 1 AS one`;
    this.outcome = { cached: await this.cache.get(DOMAIN, 'result'), database: row?.one ?? 0 };
  }
}

describe('Shutdown', () => {
  it('keeps the database and Redis connected until work in the grace period has finished', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule], providers: [GracePeriodWork] }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    const work = app.get(GracePeriodWork);

    await app.close();

    expect(work.outcome).toEqual({ cached: 'stored', database: 1 });
  });
});
