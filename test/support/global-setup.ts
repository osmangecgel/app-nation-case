import { execFileSync } from 'node:child_process';
import { Redis } from 'ioredis';
import pg from 'pg';
import { TEST_DATABASE_NAME, TEST_ENV } from './test-env.ts';

async function createTestDatabaseIfMissing(): Promise<void> {
  const maintenanceUrl = new URL(TEST_ENV.DATABASE_URL);
  maintenanceUrl.pathname = '/postgres';
  maintenanceUrl.search = '';
  const client = new pg.Client({ connectionString: maintenanceUrl.toString() });
  await client.connect();
  try {
    const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [TEST_DATABASE_NAME]);
    if (existing.rowCount === 0) {
      await client.query(`CREATE DATABASE ${client.escapeIdentifier(TEST_DATABASE_NAME)}`);
    }
  } finally {
    await client.end();
  }
}

function applyMigrations(): void {
  // DB-19: the test schema is built the same way as production.
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: TEST_ENV.DATABASE_URL },
    stdio: 'ignore',
  });
}

async function flushTestRedis(): Promise<void> {
  const redis = new Redis(TEST_ENV.CACHE_REDIS_URL);
  await redis.flushdb();
  await redis.quit();
}

// Runs once before the e2e suite. Needs `npm run db:up`.
export async function setup(): Promise<void> {
  await createTestDatabaseIfMissing();
  applyMigrations();
  await flushTestRedis();
}
