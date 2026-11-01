import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from 'dotenv';

// Where PostgreSQL and Redis are, and the database credentials, are machine
// settings: from .env (the ports docker-compose publishes on this machine) with
// the .env.example defaults. The compose `test` service, which runs inside the
// compose network, sets the hosts and ports to the services instead.
const local = { ...config({ quiet: true }).parsed, ...process.env };
const postgresUser = local.POSTGRES_USER ?? 'postgres';
const postgresPassword = local.POSTGRES_PASSWORD ?? 'postgres';
const postgresHost = local.POSTGRES_HOST ?? 'localhost';
const postgresPort = local.POSTGRES_PORT ?? '15432';
const cacheRedisHost = local.CACHE_REDIS_HOST ?? 'localhost';
const cacheRedisPort = local.CACHE_REDIS_PORT ?? '16390';

// E2e tests use their own database and Redis DB index, never the development
// data. Every variable the app reads is pinned here, so a developer's .env
// cannot change test behaviour; only the ports and credentials above follow it.
export const TEST_ENV = {
  NODE_ENV: 'test',
  DATABASE_URL: `postgresql://${postgresUser}:${postgresPassword}@${postgresHost}:${postgresPort}/app_nation_case_test?schema=public`,
  CACHE_REDIS_URL: `redis://${cacheRedisHost}:${cacheRedisPort}/1`,
  LOG_LEVEL: 'warn',
  LOG_HTTP_BODIES: 'false',
  LOG_DB_QUERIES: 'false',
  LOG_FORMAT: 'pretty',
  ERROR_INCLUDE_STACK: 'false',
  RATE_LIMIT_TTL_SECONDS: '60',
  RATE_LIMIT_MAX: '100',
  TRUST_PROXY_HOPS: '0',
  MAX_ACTIVE_JOBS_PER_USER: '50',
  JOB_CONFIG_REFRESH_MS: '30000',
  KAFKA_BROKERS: `localhost:${local.KAFKA_PORT ?? '19092'}`,
  KAFKA_CLIENT_ID: 'app-nation-case-test',
  WORKER_PROVIDER_CONCURRENCY: '4',
  WORKER_JOB_CONCURRENCY: '12',
  WORKER_LEASE_MS: '15000',
  WORKER_HEARTBEAT_MS: '5000',
  WORKER_SHUTDOWN_GRACE_MS: '25000',
  // Background loops stay quiet in tests; tests call them directly.
  OUTBOX_RELAY_INTERVAL_MS: '3600000',
  RECONCILER_INTERVAL_MS: '3600000',
  RECONCILER_STALE_QUEUED_MS: '120000',
  PORT: '13400',
  QUEUE_DRIVER: 'kafka',
  AI_PROVIDER_ADAPTERS: 'fake',
  EXPORT_MODE: 'stream',
  EXPORT_STREAM_MAX_ROWS: '10000',
  EXPORT_MAX_CONCURRENT: '200',
  EXPORT_FALLBACK_MAX_CONCURRENT: '20',
  EXPORT_ADMISSION_WAIT_MS: '10000',
  EXPORT_WORKER_CONCURRENCY: '2',
  EXPORT_FILE_TTL_MS: '86400000',
  // Prepared export files go to a temporary directory, never the project's.
  EXPORT_FILES_DIR: join(tmpdir(), 'app-nation-case-test-exports'),
};

export const TEST_DATABASE_NAME = new URL(TEST_ENV.DATABASE_URL).pathname.slice(1);
