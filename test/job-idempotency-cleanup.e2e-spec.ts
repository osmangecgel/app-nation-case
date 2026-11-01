import { Test, type TestingModule } from '@nestjs/testing';
import { JobIdempotencyCleanupModule } from '#modules/job-idempotency/job-idempotency-cleanup.module.ts';
import { JobIdempotencyCleanupService } from '#modules/job-idempotency/job-idempotency-cleanup.service.ts';
import { JobsService } from '#modules/jobs/jobs.service.ts';
import { UsersService } from '#modules/users/users.service.ts';
import { AppModule } from '../src/app.module.ts';
import { testPrisma } from './support/test-prisma.ts';

describe('Expired idempotency key cleanup', () => {
  let moduleRef: TestingModule;
  let jobs: JobsService;
  let cleanup: JobIdempotencyCleanupService;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule, JobIdempotencyCleanupModule] }).compile();
    await moduleRef.init();
    jobs = moduleRef.get(JobsService);
    cleanup = moduleRef.get(JobIdempotencyCleanupService);
  });

  afterAll(async () => {
    await moduleRef.close();
    await testPrisma.$disconnect();
  });

  beforeEach(() => moduleRef.get(UsersService).grantCredits('user-1', 100));

  // A key created 25 hours ago, valid for 24.
  const expire = (key: string) => testPrisma.$executeRaw`
    UPDATE job_idempotency_keys
       SET created_at = now() - interval '25 hours', expires_at = now() - interval '1 hour'
     WHERE idempotency_key = ${key}`;

  it('deletes expired keys and keeps live ones and every job', async () => {
    await jobs.create({ userId: 'user-1', idempotencyKey: 'old', type: 'translate', input: 'bir' });
    await jobs.create({ userId: 'user-1', idempotencyKey: 'new', type: 'translate', input: 'iki' });
    await expire('old');

    const deleted = await cleanup.deleteExpired();

    expect(deleted).toBe(1);
    const keys = await testPrisma.jobIdempotencyKey.findMany({ select: { idempotency_key: true } });
    expect(keys).toEqual([{ idempotency_key: 'new' }]);
    expect(await testPrisma.job.count()).toBe(2);
  });

  it('lets an expired key create a new job after cleanup', async () => {
    const first = await jobs.create({ userId: 'user-1', idempotencyKey: 'again', type: 'translate', input: 'bir' });
    await expire('again');
    await cleanup.deleteExpired();

    const second = await jobs.create({ userId: 'user-1', idempotencyKey: 'again', type: 'translate', input: 'bir' });

    expect(second.jobId).not.toBe(first.jobId);
  });
});
