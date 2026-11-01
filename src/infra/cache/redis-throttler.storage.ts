import { Injectable, Logger } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
import { z } from 'zod';
import { describeError } from '#shared/describe-error.ts';
import { CacheRedisClient } from './cache-redis.client.ts';

const HITS_KEY_PREFIX = 'rate_limit';
const BLOCK_KEY_PREFIX = 'rate_limit_block';
const MS_PER_SECOND = 1000;
const OUTAGE_WARNING_INTERVAL_MS = 60_000;
// Requests are allowed while this is logged (CACHE-07).
const OUTAGE_LOG_EVENT = 'RATE_LIMIT_STORAGE_UNAVAILABLE';

// Counts a hit and decides on blocking in one atomic step, so concurrent
// requests from several app instances share one counter (API-09).
// Returns { hits, window ttl ms, blocked 0|1, block ttl ms }.
const INCREMENT_SCRIPT = `
  local block_ttl = redis.call('PTTL', KEYS[2])
  if block_ttl > 0 then
    return {0, 0, 1, block_ttl}
  end
  local hits = redis.call('INCR', KEYS[1])
  if hits == 1 then
    redis.call('PEXPIRE', KEYS[1], ARGV[1])
  end
  local ttl = redis.call('PTTL', KEYS[1])
  if hits > tonumber(ARGV[2]) then
    redis.call('SET', KEYS[2], '1', 'PX', ARGV[3])
    redis.call('DEL', KEYS[1])
    return {hits, ttl, 1, tonumber(ARGV[3])}
  end
  return {hits, ttl, 0, 0}
`;

type ThrottlerStorageRecord = Awaited<ReturnType<ThrottlerStorage['increment']>>;

const ScriptResult = z.tuple([z.number(), z.number(), z.number(), z.number()]);

function toSeconds(milliseconds: number): number {
  return Math.max(0, Math.ceil(milliseconds / MS_PER_SECOND));
}

// Rate limit counters in the cache Redis. Losing a counter to eviction only
// relaxes the limit briefly, so the cache Redis is acceptable here.
@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger(RedisThrottlerStorage.name);
  private lastOutageWarningAt = 0;

  constructor(private readonly redis: CacheRedisClient) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const scopedKey = `${throttlerName}:${key}`;
    try {
      const result = await this.redis.eval(
        INCREMENT_SCRIPT,
        2,
        `${HITS_KEY_PREFIX}:${scopedKey}`,
        `${BLOCK_KEY_PREFIX}:${scopedKey}`,
        ttl,
        limit,
        blockDuration,
      );
      const [totalHits, windowMs, blocked, blockMs] = ScriptResult.parse(result);
      return {
        totalHits,
        timeToExpire: toSeconds(windowMs),
        isBlocked: blocked === 1,
        timeToBlockExpire: toSeconds(blockMs),
      };
    } catch (error) {
      // A Redis outage must not take the API down (CACHE-07): allow the request.
      this.warnOutage(describeError(error));
      return { totalHits: 0, timeToExpire: toSeconds(ttl), isBlocked: false, timeToBlockExpire: 0 };
    }
  }

  // One line per minute is enough to raise the alarm without flooding the logs.
  private warnOutage(reason: string): void {
    const now = Date.now();
    if (now - this.lastOutageWarningAt < OUTAGE_WARNING_INTERVAL_MS) {
      return;
    }
    this.lastOutageWarningAt = now;
    this.logger.warn(OUTAGE_LOG_EVENT, { reason });
  }
}
