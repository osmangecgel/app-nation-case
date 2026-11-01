import { Logger } from '@nestjs/common';
import { TEST_ENV } from '../../../test/support/test-env.ts';
import { CacheRedisClient } from './cache-redis.client.ts';
import { CacheService } from './cache.service.ts';

// Runs against the test Redis (TEST-01, db group).
const config = { get: () => TEST_ENV.CACHE_REDIS_URL } as never;

describe('CacheService', () => {
  let redis: CacheRedisClient;
  let cache: CacheService;

  beforeAll(() => {
    redis = new CacheRedisClient(config);
    cache = new CacheService(redis);
  });

  beforeEach(() => redis.flushdb());

  afterEach(() => vi.restoreAllMocks());

  afterAll(() => redis.onApplicationShutdown());

  it('stores a value under its domain with an expiry', async () => {
    await cache.set('job_result', 'abc', 'Özet', 60);

    expect(await cache.get('job_result', 'abc')).toBe('Özet');
    expect(await redis.ttl('job_result:abc')).toBeGreaterThan(55);
  });

  it('gives a lock to one caller at a time', async () => {
    expect(await cache.acquireLock('job_call_lock', 'abc', 'first', 5_000)).toBe(true);
    expect(await cache.acquireLock('job_call_lock', 'abc', 'second', 5_000)).toBe(false);
    expect(await cache.exists('job_call_lock', 'abc')).toBe(true);
  });

  it('does not release a lock that another caller holds now', async () => {
    await cache.acquireLock('job_call_lock', 'abc', 'first', 5_000);

    await cache.releaseLock('job_call_lock', 'abc', 'second');
    expect(await cache.exists('job_call_lock', 'abc')).toBe(true);

    await cache.releaseLock('job_call_lock', 'abc', 'first');
    expect(await cache.exists('job_call_lock', 'abc')).toBe(false);
  });

  it('extends a lock only for the caller that holds it', async () => {
    await cache.acquireLock('job_call_lock', 'abc', 'first', 1_000);

    expect(await cache.extendLock('job_call_lock', 'abc', 'second', 60_000)).toBe(false);
    expect(await redis.pttl('job_call_lock:abc')).toBeLessThanOrEqual(1_000);

    expect(await cache.extendLock('job_call_lock', 'abc', 'first', 60_000)).toBe(true);
    expect(await redis.pttl('job_call_lock:abc')).toBeGreaterThan(55_000);
  });

  describe('leased permits', () => {
    it('gives at most the limit of permits, and one again once released', async () => {
      expect(await cache.acquirePermit('export_slots', 'all', 'a', 2, 5_000)).toBe(true);
      expect(await cache.acquirePermit('export_slots', 'all', 'b', 2, 5_000)).toBe(true);
      expect(await cache.acquirePermit('export_slots', 'all', 'c', 2, 5_000)).toBe(false);

      await cache.releasePermit('export_slots', 'all', 'a');

      expect(await cache.acquirePermit('export_slots', 'all', 'c', 2, 5_000)).toBe(true);
    });

    it('frees the permit of a holder that stopped renewing it', async () => {
      await cache.acquirePermit('export_slots', 'all', 'crashed', 1, 50);
      await new Promise((resolve) => setTimeout(resolve, 80));

      expect(await cache.acquirePermit('export_slots', 'all', 'next', 1, 5_000)).toBe(true);
    });

    it('renews a permit only for its holder', async () => {
      await cache.acquirePermit('export_slots', 'all', 'a', 1, 100);

      expect(await cache.renewPermit('export_slots', 'all', 'a', 60_000)).toBe(true);
      expect(await cache.renewPermit('export_slots', 'all', 'stranger', 60_000)).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(await cache.acquirePermit('export_slots', 'all', 'b', 1, 5_000)).toBe(false);
    });

    it('lets the key itself expire, like every cache key', async () => {
      await cache.acquirePermit('export_slots', 'all', 'a', 1, 5_000);

      expect(await redis.pttl('export_slots:all')).toBeGreaterThan(0);
    });
  });

  describe('when Redis is unavailable', () => {
    let broken: CacheService;
    let warn: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const failing = new Error("Stream isn't writeable and enableOfflineQueue options is false");
      const client = {
        get: vi.fn().mockRejectedValue(failing),
        set: vi.fn().mockRejectedValue(failing),
        eval: vi.fn().mockRejectedValue(failing),
        exists: vi.fn().mockRejectedValue(failing),
      };
      broken = new CacheService(client as never);
    });

    it('reports a miss and no lock instead of failing', async () => {
      await expect(broken.get('job_result', 'abc')).resolves.toBeNull();
      await expect(broken.set('job_result', 'abc', 'Özet', 60)).resolves.toBeUndefined();
      await expect(broken.acquireLock('job_call_lock', 'abc', 'first', 5_000)).resolves.toBeNull();
      await expect(broken.releaseLock('job_call_lock', 'abc', 'first')).resolves.toBeUndefined();
      await expect(broken.exists('job_call_lock', 'abc')).resolves.toBeNull();
    });

    it('warns once, not on every command', async () => {
      await broken.get('job_result', 'abc');
      await broken.get('job_result', 'abc');

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith('CACHE_UNAVAILABLE', { reason: expect.any(String) });
    });
  });
});
