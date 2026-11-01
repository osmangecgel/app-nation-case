import { Injectable } from '@nestjs/common';
import { succeeds } from '#shared/succeeds.ts';
import { CacheRedisClient } from './cache-redis.client.ts';

@Injectable()
export class CacheHealthIndicator {
  constructor(private readonly redis: CacheRedisClient) {}

  isHealthy(): Promise<boolean> {
    return succeeds(async () => {
      await this.redis.ping();
    });
  }
}
