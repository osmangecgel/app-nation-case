import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '#generated/prisma/client.ts';
import { TEST_ENV } from './test-env.ts';

// Direct database access for test data (TEST-05); one client per test file.
export const testPrisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: TEST_ENV.DATABASE_URL }),
});
