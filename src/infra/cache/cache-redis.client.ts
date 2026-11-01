import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import type { Env } from '#core/config/env.validation.ts';
import { describeError } from '#shared/describe-error.ts';

const REDIS_COMMAND_TIMEOUT_MS = 500;

const RedisLogEvent = {
  CONNECTION_LOST: 'REDIS_CONNECTION_LOST',
  CONNECTION_RESTORED: 'REDIS_CONNECTION_RESTORED',
} as const;

// The connection to the cache Redis. Results, rejections, provider call locks
// and rate limit counters live here; none of them is needed for correctness.
@Injectable()
export class CacheRedisClient extends Redis implements OnApplicationShutdown {
  private readonly logger = new Logger(CacheRedisClient.name);
  private connectionLost = false;

  constructor(config: ConfigService<Env, true>) {
    // Fail fast instead of queueing commands while Redis is down, so a cache
    // outage falls back to the database without waiting (CACHE-07).
    super(config.get('CACHE_REDIS_URL', { infer: true }), {
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      // A command with no answer (e.g. a network partition) fails instead of hanging the request.
      commandTimeout: REDIS_COMMAND_TIMEOUT_MS,
    });
    // ioredis emits 'error' on every reconnect attempt; one line when the
    // connection is lost and one when it is back is enough.
    this.on('error', (error: Error) => {
      if (this.connectionLost) {
        return;
      }
      this.connectionLost = true;
      this.logger.warn(RedisLogEvent.CONNECTION_LOST, { reason: describeError(error) });
    });
    this.on('ready', () => {
      if (!this.connectionLost) {
        return;
      }
      this.connectionLost = false;
      this.logger.log(RedisLogEvent.CONNECTION_RESTORED);
    });
  }

  // Closed in the last shutdown step, after beforeApplicationShutdown: the
  // worker's grace period still settles jobs with this connection.
  async onApplicationShutdown(): Promise<void> {
    try {
      await this.quit();
    } catch {
      this.disconnect();
    }
  }
}
