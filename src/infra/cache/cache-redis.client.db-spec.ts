import { Logger } from '@nestjs/common';
import { TEST_ENV } from '../../../test/support/test-env.ts';
import { CacheRedisClient } from './cache-redis.client.ts';

// Runs against the test Redis (TEST-01, db group).
function createClient(): CacheRedisClient {
  const config = { get: () => TEST_ENV.CACHE_REDIS_URL } as never;
  return new CacheRedisClient(config);
}

describe('CacheRedisClient', () => {
  afterEach(() => vi.restoreAllMocks());

  it('warns once when the connection is lost, not on every reconnect attempt', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const client = createClient();

    client.emit('error', Object.assign(new AggregateError([], ''), { code: 'ECONNREFUSED' }));
    client.emit('error', Object.assign(new AggregateError([], ''), { code: 'ECONNREFUSED' }));

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('REDIS_CONNECTION_LOST', { reason: 'ECONNREFUSED' });
    await client.onApplicationShutdown();
  });

  it('logs once when the connection comes back', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const client = createClient();

    client.emit('error', new Error('read ECONNRESET'));
    client.emit('ready');

    expect(log).toHaveBeenCalledWith('REDIS_CONNECTION_RESTORED');
    await client.onApplicationShutdown();
  });

  it('gives up on a command that gets no answer instead of hanging', async () => {
    const client = createClient();

    expect(client.options.commandTimeout).toBeGreaterThan(0);
    await client.onApplicationShutdown();
  });

  it('disconnects when a graceful quit fails on shutdown', async () => {
    const client = createClient();
    vi.spyOn(client, 'quit').mockRejectedValue(new Error('Connection is closed.'));
    const disconnect = vi.spyOn(client, 'disconnect');

    await client.onApplicationShutdown();

    expect(disconnect).toHaveBeenCalled();
  });
});
