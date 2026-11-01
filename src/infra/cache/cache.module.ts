import { Global, Module } from '@nestjs/common';
import { CacheHealthIndicator } from './cache-health.indicator.ts';
import { CacheRedisClient } from './cache-redis.client.ts';
import { CacheService } from './cache.service.ts';
import { RedisThrottlerStorage } from './redis-throttler.storage.ts';

@Global()
@Module({
  providers: [CacheRedisClient, CacheService, CacheHealthIndicator, RedisThrottlerStorage],
  exports: [CacheService, CacheHealthIndicator, RedisThrottlerStorage],
})
export class CacheModule {}
