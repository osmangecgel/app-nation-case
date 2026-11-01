import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { CacheRedisClient } from './cache-redis.client.ts';
import { RedisThrottlerStorage } from './redis-throttler.storage.ts';

const TTL_MS = 60_000;
const LIMIT = 3;
const BLOCK_MS = 60_000;

async function createStorage(
  evalResult: Promise<number[]>,
): Promise<{ storage: RedisThrottlerStorage; evalMock: ReturnType<typeof vi.fn> }> {
  const evalMock = vi.fn().mockReturnValue(evalResult);
  const moduleRef = await Test.createTestingModule({
    providers: [RedisThrottlerStorage, { provide: CacheRedisClient, useValue: { eval: evalMock } }],
  }).compile();
  return { storage: moduleRef.get(RedisThrottlerStorage), evalMock };
}

describe('RedisThrottlerStorage', () => {
  it('counts a hit and reports the remaining window in seconds', async () => {
    const { storage, evalMock } = await createStorage(Promise.resolve([2, 59_001, 0, 0]));

    await expect(storage.increment('abc', TTL_MS, LIMIT, BLOCK_MS, 'default')).resolves.toEqual({
      totalHits: 2,
      timeToExpire: 60,
      isBlocked: false,
      timeToBlockExpire: 0,
    });
    expect(evalMock).toHaveBeenCalledWith(
      expect.any(String),
      2,
      'rate_limit:default:abc',
      'rate_limit_block:default:abc',
      TTL_MS,
      LIMIT,
      BLOCK_MS,
    );
  });

  it('reports a blocked client with the time until the block ends', async () => {
    const { storage } = await createStorage(Promise.resolve([4, 30_000, 1, BLOCK_MS]));

    await expect(storage.increment('abc', TTL_MS, LIMIT, BLOCK_MS, 'default')).resolves.toEqual(
      expect.objectContaining({ isBlocked: true, timeToBlockExpire: 60 }),
    );
  });

  it('allows the request when Redis rejects with a non-error value', async () => {
    const { storage } = await createStorage(Promise.reject('NOSCRIPT'));

    await expect(storage.increment('abc', TTL_MS, LIMIT, BLOCK_MS, 'default')).resolves.toEqual(
      expect.objectContaining({ isBlocked: false }),
    );
  });

  it('warns once per minute, not on every request, while Redis is down', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { storage } = await createStorage(Promise.reject(new Error('Connection is closed.')));

    await storage.increment('a', TTL_MS, LIMIT, BLOCK_MS, 'default');
    await storage.increment('b', TTL_MS, LIMIT, BLOCK_MS, 'default');

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('RATE_LIMIT_STORAGE_UNAVAILABLE', expect.any(Object));
    warn.mockRestore();
  });

  it('allows the request when Redis is unavailable (CACHE-07)', async () => {
    const { storage } = await createStorage(Promise.reject(new Error('Connection is closed.')));

    await expect(storage.increment('abc', TTL_MS, LIMIT, BLOCK_MS, 'default')).resolves.toEqual(
      expect.objectContaining({ isBlocked: false }),
    );
  });
});
