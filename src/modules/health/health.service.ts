import { Injectable } from '@nestjs/common';
import { CacheHealthIndicator } from '#infra/cache/cache-health.indicator.ts';
import { DatabaseHealthIndicator } from '#infra/database/database-health.indicator.ts';
import { type HealthDto, toHealthDto } from './dto/health.dto.ts';

@Injectable()
export class HealthService {
  constructor(
    private readonly database: DatabaseHealthIndicator,
    private readonly cache: CacheHealthIndicator,
  ) {}

  async check(): Promise<HealthDto> {
    const [database, cache] = await Promise.all([this.database.isHealthy(), this.cache.isHealthy()]);
    return toHealthDto({ database, cache });
  }
}
