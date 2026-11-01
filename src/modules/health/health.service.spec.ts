import { Test } from '@nestjs/testing';
import { CacheHealthIndicator } from '#infra/cache/cache-health.indicator.ts';
import { DatabaseHealthIndicator } from '#infra/database/database-health.indicator.ts';
import type { HealthCheckResults } from './dto/health.dto.ts';
import { ComponentStatus, HealthStatus } from './health.constants.ts';
import { HealthService } from './health.service.ts';

async function createService(results: HealthCheckResults): Promise<HealthService> {
  const moduleRef = await Test.createTestingModule({
    providers: [
      HealthService,
      { provide: DatabaseHealthIndicator, useValue: { isHealthy: vi.fn().mockResolvedValue(results.database) } },
      { provide: CacheHealthIndicator, useValue: { isHealthy: vi.fn().mockResolvedValue(results.cache) } },
    ],
  }).compile();

  return moduleRef.get(HealthService);
}

describe('HealthService', () => {
  it('reports ok when every component is up', async () => {
    const service = await createService({ database: true, cache: true });

    await expect(service.check()).resolves.toEqual({
      status: HealthStatus.OK,
      database: ComponentStatus.UP,
      cache: ComponentStatus.UP,
    });
  });

  it('reports degraded when only the cache is down: the API keeps working without it', async () => {
    const service = await createService({ database: true, cache: false });

    await expect(service.check()).resolves.toEqual({
      status: HealthStatus.DEGRADED,
      database: ComponentStatus.UP,
      cache: ComponentStatus.DOWN,
    });
  });

  it('reports error when the database is down, whatever the cache does', async () => {
    const service = await createService({ database: false, cache: true });

    await expect(service.check()).resolves.toEqual({
      status: HealthStatus.ERROR,
      database: ComponentStatus.DOWN,
      cache: ComponentStatus.UP,
    });
  });
});
