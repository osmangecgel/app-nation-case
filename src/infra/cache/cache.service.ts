import { Injectable, Logger } from '@nestjs/common';
import { describeError } from '#shared/describe-error.ts';
import { CacheRedisClient } from './cache-redis.client.ts';

// Releases a lock only if it still holds the caller's token: a holder whose
// lock expired and was taken by someone else cannot delete the new lock.
const RELEASE_LOCK_SCRIPT = `
  if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
  end
  return 0
`;

// Extends a lock only if it still holds the caller's token, for the same reason.
const EXTEND_LOCK_SCRIPT = `
  if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('PEXPIRE', KEYS[1], ARGV[2])
  end
  return 0
`;

// Leased permits: a sorted set of holders scored by the time their lease ends,
// on Redis's own clock. Expired holders are dropped first, so a crashed
// holder's permit frees itself. The key expires too (CACHE-04), and every
// acquire or renew pushes its expiry past the newest lease.
const PERMIT_NOW = `
  local time = redis.call('TIME')
  local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
  redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
`;
const ACQUIRE_PERMIT_SCRIPT = `${PERMIT_NOW}
  if redis.call('ZSCORE', KEYS[1], ARGV[1]) or redis.call('ZCARD', KEYS[1]) < tonumber(ARGV[2]) then
    redis.call('ZADD', KEYS[1], now + tonumber(ARGV[3]), ARGV[1])
    redis.call('PEXPIRE', KEYS[1], ARGV[3])
    return 1
  end
  return 0
`;
const RENEW_PERMIT_SCRIPT = `${PERMIT_NOW}
  if redis.call('ZSCORE', KEYS[1], ARGV[1]) then
    redis.call('ZADD', KEYS[1], now + tonumber(ARGV[2]), ARGV[1])
    redis.call('PEXPIRE', KEYS[1], ARGV[2])
    return 1
  end
  return 0
`;

const OUTAGE_LOG_EVENT = 'CACHE_UNAVAILABLE';
const OUTAGE_WARNING_INTERVAL_MS = 60_000;

// The only way code reaches the cache Redis (CACHE-01). Every key is
// `<domain>:<id>` and every value expires (CACHE-03, CACHE-04).
//
// The cache only speeds things up; nothing depends on it for correctness. A
// Redis error is logged (once a minute) and reported as a miss, so an outage
// makes the system slower and more expensive, never wrong or down (CACHE-07).
// The client fails fast instead of queueing commands, so an outage costs at
// most its command timeout per call.
@Injectable()
export class CacheService {
  private readonly logger = new Logger(CacheService.name);
  private lastOutageWarningAt = 0;

  constructor(private readonly redis: CacheRedisClient) {}

  async get(domain: string, id: string): Promise<string | null> {
    try {
      return await this.redis.get(`${domain}:${id}`);
    } catch (error) {
      this.warnOutage(describeError(error));
      return null;
    }
  }

  async set(domain: string, id: string, value: string, ttlSeconds: number): Promise<void> {
    try {
      await this.redis.set(`${domain}:${id}`, value, 'EX', ttlSeconds);
    } catch (error) {
      this.warnOutage(describeError(error));
    }
  }

  // True when the lock was taken, false when someone else holds it, null when
  // Redis is unavailable (the caller decides whether to go on without it).
  async acquireLock(domain: string, id: string, token: string, ttlMs: number): Promise<boolean | null> {
    try {
      return (await this.redis.set(`${domain}:${id}`, token, 'PX', ttlMs, 'NX')) === 'OK';
    } catch (error) {
      this.warnOutage(describeError(error));
      return null;
    }
  }

  async releaseLock(domain: string, id: string, token: string): Promise<void> {
    try {
      await this.redis.eval(RELEASE_LOCK_SCRIPT, 1, `${domain}:${id}`, token);
    } catch (error) {
      // The lock expires on its own.
      this.warnOutage(describeError(error));
    }
  }

  // Sets the lock to expire ttlMs from now. False when the caller no longer
  // holds it, null when Redis is unavailable.
  async extendLock(domain: string, id: string, token: string, ttlMs: number): Promise<boolean | null> {
    try {
      return (await this.redis.eval(EXTEND_LOCK_SCRIPT, 1, `${domain}:${id}`, token, ttlMs)) === 1;
    } catch (error) {
      this.warnOutage(describeError(error));
      return null;
    }
  }

  // One of at most `limit` permits shared by every instance, held for ttlMs
  // unless renewed. True when taken, false when all are held, null when Redis
  // is unavailable (the caller decides what to do without it).
  async acquirePermit(
    domain: string,
    id: string,
    holder: string,
    limit: number,
    ttlMs: number,
  ): Promise<boolean | null> {
    try {
      return (await this.redis.eval(ACQUIRE_PERMIT_SCRIPT, 1, `${domain}:${id}`, holder, limit, ttlMs)) === 1;
    } catch (error) {
      this.warnOutage(describeError(error));
      return null;
    }
  }

  // False when the holder no longer has the permit (its lease ended).
  async renewPermit(domain: string, id: string, holder: string, ttlMs: number): Promise<boolean | null> {
    try {
      return (await this.redis.eval(RENEW_PERMIT_SCRIPT, 1, `${domain}:${id}`, holder, ttlMs)) === 1;
    } catch (error) {
      this.warnOutage(describeError(error));
      return null;
    }
  }

  async releasePermit(domain: string, id: string, holder: string): Promise<void> {
    try {
      await this.redis.zrem(`${domain}:${id}`, holder);
    } catch (error) {
      // The lease ends on its own.
      this.warnOutage(describeError(error));
    }
  }

  // Null when the key does not exist or Redis is unavailable.
  async exists(domain: string, id: string): Promise<boolean | null> {
    try {
      return (await this.redis.exists(`${domain}:${id}`)) === 1;
    } catch (error) {
      this.warnOutage(describeError(error));
      return null;
    }
  }

  private warnOutage(reason: string): void {
    const now = Date.now();
    if (now - this.lastOutageWarningAt < OUTAGE_WARNING_INTERVAL_MS) {
      return;
    }
    this.lastOutageWarningAt = now;
    this.logger.warn(OUTAGE_LOG_EVENT, { reason });
  }
}
