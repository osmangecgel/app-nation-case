import { LogFormat, NodeEnv, QueueDriver } from './env.constants.ts';
import { validateEnv } from './env.validation.ts';

const REQUIRED_ENV = {
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:15432/app',
  CACHE_REDIS_URL: 'redis://localhost:16390',
};

describe('validateEnv', () => {
  it('uses the pretty log format in development by default', () => {
    const env = validateEnv({ ...REQUIRED_ENV, NODE_ENV: NodeEnv.DEVELOPMENT });

    expect(env.LOG_FORMAT).toBe(LogFormat.PRETTY);
  });

  it('uses the json log format outside development by default', () => {
    const env = validateEnv({ ...REQUIRED_ENV, NODE_ENV: NodeEnv.PRODUCTION });

    expect(env.LOG_FORMAT).toBe(LogFormat.JSON);
  });

  it('reads boolean flags from strings', () => {
    const env = validateEnv({ ...REQUIRED_ENV, LOG_HTTP_BODIES: 'true', LOG_DB_QUERIES: 'false' });

    expect(env.LOG_HTTP_BODIES).toBe(true);
    expect(env.LOG_DB_QUERIES).toBe(false);
  });

  it('rejects stack traces in error responses in production (ERR-08)', () => {
    expect(() => validateEnv({ ...REQUIRED_ENV, NODE_ENV: NodeEnv.PRODUCTION, ERROR_INCLUDE_STACK: 'true' })).toThrow(
      /ERROR_INCLUDE_STACK/,
    );
  });

  it('rejects a missing database url', () => {
    expect(() => validateEnv({ ...REQUIRED_ENV, DATABASE_URL: undefined })).toThrow(/DATABASE_URL/);
  });

  it('uses the Kafka queue driver and the fake AI provider by default', () => {
    const env = validateEnv(REQUIRED_ENV);

    expect(env.QUEUE_DRIVER).toBe(QueueDriver.KAFKA);
    expect(env.AI_PROVIDER_ADAPTERS).toEqual(['fake']);
  });

  it('rejects a queue driver this build has no adapter for', () => {
    expect(() => validateEnv({ ...REQUIRED_ENV, QUEUE_DRIVER: 'bullmq' })).toThrow(/QUEUE_DRIVER/);
  });

  it('reads the AI provider adapters as a comma-separated list', () => {
    const env = validateEnv({ ...REQUIRED_ENV, AI_PROVIDER_ADAPTERS: 'fake, openai' });

    expect(env.AI_PROVIDER_ADAPTERS).toEqual(['fake', 'openai']);
  });
});
