import { Logger } from '@nestjs/common';
import { NodeEnv } from '#core/config/env.constants.ts';
import { TEST_ENV } from '../../../test/support/test-env.ts';
import { PrismaService } from './prisma.service.ts';

// Runs against the test database (TEST-01, db group).
function createService(nodeEnv: NodeEnv, logQueries: boolean): PrismaService {
  const settings: Record<string, string | boolean | undefined> = {
    DATABASE_URL: TEST_ENV.DATABASE_URL,
    NODE_ENV: nodeEnv,
    LOG_DB_QUERIES: logQueries,
  };
  const config = { get: (key: string) => settings[key] } as never;
  return new PrismaService(config);
}

describe('PrismaService query logging (LOG-08)', () => {
  const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  let service: PrismaService | undefined;

  beforeEach(() => log.mockClear());

  afterEach(async () => {
    await service?.onApplicationShutdown();
  });

  it('logs queries with their parameters in development', async () => {
    service = createService(NodeEnv.DEVELOPMENT, true);

    await service.$queryRaw`SELECT ${1}::int AS value`;

    expect(log).toHaveBeenCalledWith(
      'DATABASE_QUERY',
      expect.objectContaining({ query: expect.stringContaining('SELECT'), params: expect.any(String) }),
    );
  });

  it('leaves the parameters out outside development', async () => {
    service = createService(NodeEnv.PRODUCTION, true);

    await service.$queryRaw`SELECT ${1}::int AS value`;

    expect(log.mock.lastCall?.[1]).not.toHaveProperty('params');
  });

  it('logs nothing when LOG_DB_QUERIES is off', async () => {
    service = createService(NodeEnv.DEVELOPMENT, false);

    await service.$queryRaw`SELECT 1`;

    expect(log).not.toHaveBeenCalled();
  });
});
