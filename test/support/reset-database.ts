import { Redis } from 'ioredis';
import pg from 'pg';
import { TEST_ENV } from './test-env.ts';

// Empties every application table and the test Redis database before each
// test, so every test starts from a clean state (TEST-06). The statement
// is static SQL; table names come from pg_tables. The job configuration
// tables are kept: their rows come from a migration, like in production.
const TRUNCATE_ALL_TABLES = `
  DO $$
  DECLARE table_row record;
  BEGIN
    FOR table_row IN
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename NOT IN ('_prisma_migrations', 'job_types', 'job_providers', 'job_type_routes')
    LOOP
      EXECUTE 'TRUNCATE TABLE ' || quote_ident(table_row.tablename) || ' RESTART IDENTITY CASCADE';
    END LOOP;
  END $$;
`;

const client = new pg.Client({ connectionString: TEST_ENV.DATABASE_URL });
const redis = new Redis(TEST_ENV.CACHE_REDIS_URL);

beforeAll(async () => {
  await client.connect();
});

// Rate limit counters and other Redis keys are cleared too, so no test sees another's state.
beforeEach(async () => {
  await client.query(TRUNCATE_ALL_TABLES);
  await redis.flushdb();
});

afterAll(async () => {
  await client.end();
  await redis.quit();
});
