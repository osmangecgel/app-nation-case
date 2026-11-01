import { Test, type TestingModule } from '@nestjs/testing';
import { Redis } from 'ioredis';
import { TransientAiError, PermanentAiError } from '#infra/ai-provider/ai-provider.ts';
import { AI_PROVIDERS } from '#infra/ai-provider/ai-provider.registry.ts';
import { JobConfigService } from '#modules/job-config/job-config.service.ts';
import { JobProcessingModule } from '#modules/job-worker/job-processing.module.ts';
import { JobProcessorService } from '#modules/job-worker/job-processor.service.ts';
import { JobReconcilerService } from '#modules/job-worker/job-reconciler.service.ts';
import { JobLifecycleService } from '#modules/jobs/job-lifecycle.service.ts';
import { JobsService } from '#modules/jobs/jobs.service.ts';
import { UsersService } from '#modules/users/users.service.ts';
import { AppModule } from '../src/app.module.ts';
import { ControllableAiProvider, waitFor } from './support/controllable-ai-provider.ts';
import { creditState } from './support/credits.ts';
import { testPrisma } from './support/test-prisma.ts';
import { TEST_ENV } from './support/test-env.ts';

const REQUEST_ID = '4bf92f3577b34da6a3ce929d0e0e4736';

describe('Job processing', () => {
  let moduleRef: TestingModule;
  let provider: ControllableAiProvider;
  let processor: JobProcessorService;
  let jobs: JobsService;
  let users: UsersService;
  let keySequence = 0;

  async function createModule(): Promise<void> {
    provider = new ControllableAiProvider();
    moduleRef = await Test.createTestingModule({ imports: [AppModule, JobProcessingModule] })
      .overrideProvider(AI_PROVIDERS)
      .useValue([provider])
      .compile();
    await moduleRef.init();
    processor = moduleRef.get(JobProcessorService);
    jobs = moduleRef.get(JobsService);
    users = moduleRef.get(UsersService);
  }

  async function createJob(input = 'merhaba', type = 'summary', userId = 'user-1'): Promise<string> {
    keySequence += 1;
    const { jobId } = await jobs.create({ userId, idempotencyKey: `key-${keySequence}`, type, input });
    return jobId;
  }

  const job = (id: string) => testPrisma.job.findUniqueOrThrow({ where: { id }, include: { content: true } });
  // The cache key of a job's content: the hex of its content hash.
  const contentKey = async (id: string) => Buffer.from((await job(id)).content.content_hash).toString('hex');
  const redis = new Redis(TEST_ENV.CACHE_REDIS_URL);
  // Longer than the poll interval of a worker waiting for another worker's call.
  const letFollowerPoll = () => new Promise((resolve) => setTimeout(resolve, 300));

  beforeAll(createModule);

  beforeEach(async () => {
    provider.reset();
    await users.grantCredits('user-1', 100);
  });

  afterAll(async () => {
    await moduleRef.close();
    await testPrisma.$disconnect();
    await redis.quit();
  });

  it('completes a job, captures its credits and stores the result', async () => {
    const jobId = await createJob('Merhaba   Dünya');
    const done = processor.process(jobId, REQUEST_ID);
    await waitFor(() => provider.pending === 1);

    provider.respond();
    await done;

    const finished = await job(jobId);
    expect(finished).toMatchObject({ status: 'completed', result_source: 'provider', attempt_count: 1 });
    expect(finished.content.result).toBe('Özet: merhaba dünya');
    expect(provider.calls[0]).toEqual({ jobType: 'summary', input: 'merhaba dünya', modelVersion: 'fake-v1' });
    expect(await creditState('user-1')).toEqual({ balance: 97, reserved: 0, ledgerBalance: 97, ledgerReserved: 0 });
  });

  it("keeps the result in the cache Redis for the type's cache TTL", async () => {
    const jobId = await createJob();
    const done = processor.process(jobId, REQUEST_ID);
    await waitFor(() => provider.pending === 1);
    provider.respond();
    await done;

    const key = `job_result:${await contentKey(jobId)}`;
    expect(await redis.get(key)).toBe('Özet: merhaba');
    expect(await redis.ttl(key)).toBeGreaterThan(3500);
  });

  it('serves a job from the cache Redis without calling the provider', async () => {
    const jobId = await createJob();
    await redis.set(`job_result:${await contentKey(jobId)}`, 'Özet: önceden', 'EX', 60);

    await processor.process(jobId, REQUEST_ID);

    expect(provider.calls).toHaveLength(0);
    expect(await job(jobId)).toMatchObject({ status: 'completed', result_source: 'cache' });
    expect((await creditState('user-1')).balance).toBe(97);
  });

  it('stores a result found only in Redis, so no job is completed without a result', async () => {
    // A worker cached the provider's answer and died before its settlement committed.
    const jobId = await createJob();
    await redis.set(`job_result:${await contentKey(jobId)}`, 'Özet: önceden', 'EX', 60);

    await processor.process(jobId, REQUEST_ID);

    expect((await job(jobId)).content.result).toBe('Özet: önceden');
  });

  it('serves a job from the stored result when Redis lost it, and puts it back in Redis', async () => {
    const first = await createJob();
    const done = processor.process(first, REQUEST_ID);
    await waitFor(() => provider.pending === 1);
    provider.respond();
    await done;
    await redis.flushdb();

    const second = await createJob();
    await processor.process(second, REQUEST_ID);

    expect(provider.calls).toHaveLength(1);
    expect(await job(second)).toMatchObject({ status: 'completed', result_source: 'cache', attempt_count: 1 });
    expect(await redis.get(`job_result:${await contentKey(second)}`)).toBe('Özet: merhaba');
  });

  it("keeps using the stored result after the cache TTL, so a finished job's result never changes", async () => {
    const first = await createJob();
    const done = processor.process(first, REQUEST_ID);
    await waitFor(() => provider.pending === 1);
    provider.respond();
    await done;
    // Two hours later: Redis has expired the result.
    await redis.flushdb();
    await testPrisma.jobContent.updateMany({ data: { result_at: new Date(Date.now() - 2 * 60 * 60 * 1000) } });

    const second = await createJob();
    await processor.process(second, REQUEST_ID);

    expect(provider.calls).toHaveLength(1);
    expect(await job(second)).toMatchObject({ status: 'completed', result_source: 'cache' });
    expect((await job(first)).content.result).toBe('Özet: merhaba');
  });

  it('keeps the first result when a duplicate provider call answers differently', async () => {
    const jobId = await createJob();
    const done = processor.process(jobId, REQUEST_ID);
    await waitFor(() => provider.pending === 1);
    // Another worker's call for the same content finished first.
    await testPrisma.jobContent.updateMany({ data: { result: 'Özet: ilk cevap', result_at: new Date() } });
    provider.respond('Özet: ikinci cevap');
    await done;

    expect((await job(jobId)).content.result).toBe('Özet: ilk cevap');
  });

  // The case's automated test (c).
  it('(c) 20 jobs with the same input: one provider call, 20 completed, 20 captures', async () => {
    const ids = await Promise.all(Array.from({ length: 20 }, () => createJob('aynı metin')));
    const done = Promise.all(ids.map((id) => processor.process(id, REQUEST_ID)));
    await waitFor(() => provider.pending === 1);
    await letFollowerPoll();
    // Only the job making the call is claimed; the others wait for its answer.
    expect(await testPrisma.job.count({ where: { status: 'processing' } })).toBe(1);

    provider.respond();
    await done;

    expect(provider.calls).toHaveLength(1);
    // The other 19 reuse that call's result: shared while it runs, or from the
    // cache when a job only got there after it ended (how many of each depends on timing).
    expect(await testPrisma.job.count({ where: { result_source: 'provider' } })).toBe(1);
    expect(await testPrisma.job.count({ where: { result_source: { in: ['coalesced', 'cache'] } } })).toBe(19);
    expect(await testPrisma.job.count({ where: { status: 'completed' } })).toBe(20);
    expect(await testPrisma.userCreditLedgerEntry.count({ where: { entry_type: 'capture' } })).toBe(20);
    expect(await creditState('user-1')).toEqual({ balance: 40, reserved: 0, ledgerBalance: 40, ledgerReserved: 0 });
  });

  it('fails a job the provider rejects and releases its credits', async () => {
    const jobId = await createJob('fail deneme');
    const done = processor.process(jobId, REQUEST_ID);
    await waitFor(() => provider.pending === 1);

    provider.fail(new PermanentAiError('rejected'));
    await done;

    expect(await job(jobId)).toMatchObject({ status: 'failed', error_code: 'provider_rejected' });
    expect(await creditState('user-1')).toEqual({ balance: 100, reserved: 0, ledgerBalance: 100, ledgerReserved: 0 });
  });

  it('fails the same input again without a provider call after a rejection', async () => {
    const first = await createJob('fail deneme');
    const done = processor.process(first, REQUEST_ID);
    await waitFor(() => provider.pending === 1);
    provider.fail(new PermanentAiError('rejected'));
    await done;

    const second = await createJob('fail deneme');
    await processor.process(second, REQUEST_ID);

    expect(provider.calls).toHaveLength(1);
    expect(await job(second)).toMatchObject({ status: 'failed', error_code: 'provider_rejected' });
    expect((await creditState('user-1')).balance).toBe(100);
  });

  it('waits for another worker calling the provider for the same content and uses its result', async () => {
    const jobId = await createJob();
    const key = await contentKey(jobId);
    await redis.set(`job_call_lock:${key}`, 'other-worker', 'PX', 10_000);

    const done = processor.process(jobId, REQUEST_ID);
    await letFollowerPoll();
    expect(provider.calls).toHaveLength(0);
    await redis.set(`job_result:${key}`, 'Özet: diğer worker', 'EX', 60);
    await redis.del(`job_call_lock:${key}`);
    await done;

    expect(provider.calls).toHaveLength(0);
    expect(await job(jobId)).toMatchObject({ status: 'completed', result_source: 'coalesced' });
  });

  it("calls the provider itself when the other worker's call ends without an answer", async () => {
    const jobId = await createJob();
    const key = await contentKey(jobId);
    await redis.set(`job_call_lock:${key}`, 'other-worker', 'PX', 10_000);

    const done = processor.process(jobId, REQUEST_ID);
    await letFollowerPoll();
    await redis.del(`job_call_lock:${key}`);
    await waitFor(() => provider.pending === 1);
    provider.respond();
    await done;

    expect(await job(jobId)).toMatchObject({ status: 'completed', result_source: 'provider' });
    expect(await redis.exists(`job_call_lock:${key}`)).toBe(0);
  });

  it('puts a job back in the queue with a delay after a transient error', async () => {
    const jobId = await createJob('flaky deneme');
    const done = processor.process(jobId, REQUEST_ID);
    await waitFor(() => provider.pending === 1);

    provider.fail(new TransientAiError('busy'));
    await done;

    const retried = await job(jobId);
    expect(retried).toMatchObject({ status: 'queued', attempt_count: 1, dispatch_count: 1, lock_token: null });
    expect(retried.run_after.getTime()).toBeGreaterThan(Date.now());
    const message = await testPrisma.jobOutboxMessage.findFirstOrThrow({
      where: { job_id: jobId },
      orderBy: { created_at: 'desc' },
    });
    expect(message.not_before.getTime()).toBe(retried.run_after.getTime());
    expect(message.request_id).toBe(REQUEST_ID);
    expect((await creditState('user-1')).reserved).toBe(3);
  });

  it("measures the retry delay on the database's clock, not the worker's", async () => {
    const jobId = await createJob('flaky deneme');
    const done = processor.process(jobId, REQUEST_ID);
    await waitFor(() => provider.pending === 1);
    // The worker's clock is an hour ahead of the database's from here on.
    const realNow = Date.now.bind(Date);
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 60 * 60 * 1000);

    provider.fail(new TransientAiError('busy'));
    await done;
    clock.mockRestore();

    const retried = await job(jobId);
    const delayMs = retried.run_after.getTime() - retried.updated_at.getTime();
    expect(delayMs).toBeGreaterThanOrEqual(1000);
    expect(delayMs).toBeLessThan(2000);
  });

  it("takes a new job even when the API's clock is ahead of the database's", async () => {
    const jobId = await createJob();
    // run_after is written with the API's clock and the claim compares it with the database's.
    await testPrisma.$executeRaw`UPDATE jobs SET run_after = now() + interval '1 second' WHERE id = ${jobId}::uuid`;

    const done = processor.process(jobId, REQUEST_ID);
    await waitFor(() => provider.pending === 1);
    provider.respond();
    await done;

    expect(await job(jobId)).toMatchObject({ status: 'completed', attempt_count: 1 });
  });

  it('does not take a retried job before its retry time', async () => {
    const jobId = await createJob();
    await testPrisma.$executeRaw`
      UPDATE jobs SET attempt_count = 1, run_after = now() + interval '1 minute' WHERE id = ${jobId}::uuid`;

    await processor.process(jobId, REQUEST_ID);

    expect(provider.calls).toHaveLength(0);
    expect(await job(jobId)).toMatchObject({ status: 'queued', attempt_count: 1 });
  });

  it('fails a job whose last attempt hits a transient error and releases its credits', async () => {
    const jobId = await createJob('flaky deneme');
    await testPrisma.job.update({ where: { id: jobId }, data: { attempt_count: 2 } });
    const done = processor.process(jobId, REQUEST_ID);
    await waitFor(() => provider.pending === 1);

    provider.fail(new TransientAiError('busy'));
    await done;

    expect(await job(jobId)).toMatchObject({ status: 'failed', error_code: 'provider_unavailable', attempt_count: 3 });
    expect((await creditState('user-1')).balance).toBe(100);
  });

  it('counts a provider timeout as a transient error', async () => {
    const config = moduleRef.get(JobConfigService);
    await testPrisma.jobType.update({ where: { code: 'summary' }, data: { timeout_ms: 50 } });
    await config.refresh();
    try {
      const jobId = await createJob('hang deneme');

      await processor.process(jobId, REQUEST_ID);

      expect(await job(jobId)).toMatchObject({ status: 'queued', attempt_count: 1 });
      expect(provider.pending).toBe(0);
    } finally {
      await testPrisma.jobType.update({ where: { code: 'summary' }, data: { timeout_ms: 10_000 } });
      await config.refresh();
    }
  });

  it('times a call out even when the provider ignores the abort signal', async () => {
    const config = moduleRef.get(JobConfigService);
    await testPrisma.jobType.update({ where: { code: 'summary' }, data: { timeout_ms: 50 } });
    await config.refresh();
    // An adapter that never settles and never looks at its signal.
    const deaf = vi.spyOn(provider, 'generate').mockReturnValue(new Promise(() => undefined));
    try {
      const jobId = await createJob('hang deneme');

      await processor.process(jobId, REQUEST_ID);

      expect(await job(jobId)).toMatchObject({ status: 'queued', attempt_count: 1, error_code: null });
    } finally {
      deaf.mockRestore();
      await testPrisma.jobType.update({ where: { code: 'summary' }, data: { timeout_ms: 10_000 } });
      await config.refresh();
    }
  });

  it('writes nothing when the worker lost the job meanwhile', async () => {
    const jobId = await createJob();
    const done = processor.process(jobId, REQUEST_ID);
    await waitFor(() => provider.pending === 1);
    // Another worker took the job over after this one's lease expired.
    await testPrisma.$executeRaw`UPDATE jobs SET lock_token = gen_random_uuid() WHERE id = ${jobId}::uuid`;

    provider.respond();
    await done;

    expect(await job(jobId)).toMatchObject({ status: 'processing' });
    expect(await testPrisma.userCreditLedgerEntry.count({ where: { entry_type: 'capture' } })).toBe(0);
  });

  // TEST_ENV allows 4 provider calls at once: the fifth job waits.
  async function fillPermits(): Promise<{ jobIds: string[]; done: Promise<boolean[]> }> {
    const jobIds: string[] = [];
    for (let n = 0; n < 5; n += 1) {
      jobIds.push(await createJob(`metin ${n}`));
    }
    const done = Promise.all(jobIds.map((id) => processor.process(id, REQUEST_ID)));
    await waitFor(() => provider.pending === 4);
    await letFollowerPoll();
    return { jobIds, done };
  }

  const unclaimed = () => testPrisma.job.count({ where: { status: 'queued', attempt_count: 0, lock_token: null } });

  it('does not claim a job until a permit is free', async () => {
    const { jobIds, done } = await fillPermits();

    expect(await unclaimed()).toBe(1);

    provider.respond();
    await waitFor(() => provider.pending === 1);
    provider.respond();
    await done;
    const finished = await testPrisma.job.findMany({ where: { id: { in: jobIds } } });
    expect(finished.map((row) => [row.status, row.attempt_count])).toEqual(Array(5).fill(['completed', 1]));
  });

  it('processes a job once when two deliveries arrive together', async () => {
    const jobId = await createJob();
    const done = Promise.all([processor.process(jobId, REQUEST_ID), processor.process(jobId, REQUEST_ID)]);
    await waitFor(() => provider.pending === 1);

    provider.respond();
    await done;

    expect(provider.calls).toHaveLength(1);
    expect(await testPrisma.userCreditLedgerEntry.count({ where: { entry_type: 'capture' } })).toBe(1);
  });

  it('lets a job waiting on another job for the same text take over when that job hits a database error', async () => {
    const lifecycle = moduleRef.get(JobLifecycleService);
    const claim = vi.spyOn(lifecycle, 'claim').mockRejectedValueOnce(new Error('connection reset'));
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const ids = [await createJob('ayni metin'), await createJob('ayni metin')];

    // Whichever job claims first gets the error; the other must not wait forever.
    const outcomes = ids.map((id) =>
      processor.process(id, REQUEST_ID).then(
        () => 'done',
        (error: Error) => error.message,
      ),
    );
    await waitFor(() => provider.pending === 1);
    provider.respond();

    expect((await Promise.all(outcomes)).sort()).toEqual(['connection reset', 'done']);
    const statuses = await Promise.all(ids.map(async (id) => (await job(id)).status));
    expect(statuses.sort()).toEqual(['completed', 'queued']);
    expect(unhandled).not.toHaveBeenCalled();
    process.off('unhandledRejection', unhandled);
    claim.mockRestore();
  });

  it("counts the call lock's lifetime from the start of the provider call, not from before the claim", async () => {
    const lifecycle = moduleRef.get(JobLifecycleService);
    const claim = lifecycle.claim.bind(lifecycle);
    // A slow claim: the database is busy.
    const slowClaim = vi.spyOn(lifecycle, 'claim').mockImplementation(async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      return claim(...args);
    });
    const jobId = await createJob();
    const done = processor.process(jobId, REQUEST_ID);
    await waitFor(() => provider.pending === 1);

    // The provider call has the whole 10 s timeout plus the 5 s margin ahead of
    // it. Counted from before the 2 s claim, at most 13 s would be left.
    expect(await redis.pttl(`job_call_lock:${await contentKey(jobId)}`)).toBeGreaterThan(14_000);
    provider.respond();
    await done;
    slowClaim.mockRestore();
  }, 10_000);

  describe('reconciler', () => {
    const expireLease = (jobId: string, attemptCount: number) => testPrisma.$executeRaw`
      UPDATE jobs SET status = 'processing', attempt_count = ${attemptCount}, lock_token = gen_random_uuid(),
                      locked_until = now() - interval '1 second'
       WHERE id = ${jobId}::uuid`;

    it('puts a job whose worker died back in the queue', async () => {
      const jobId = await createJob();
      await expireLease(jobId, 1);

      await moduleRef.get(JobReconcilerService).reconcile();

      expect(await job(jobId)).toMatchObject({ status: 'queued', lock_token: null, dispatch_count: 1 });
      expect(await testPrisma.jobOutboxMessage.count({ where: { job_id: jobId, sent_at: null } })).toBe(2);
    });

    it('fails a job whose worker died during its last attempt and releases its credits', async () => {
      const jobId = await createJob();
      await expireLease(jobId, 3);

      await moduleRef.get(JobReconcilerService).reconcile();

      expect(await job(jobId)).toMatchObject({ status: 'failed', error_code: 'worker_lost' });
      expect(await creditState('user-1')).toEqual({ balance: 100, reserved: 0, ledgerBalance: 100, ledgerReserved: 0 });
    });

    it('dispatches a queued job again when nobody picked it up', async () => {
      const jobId = await createJob();
      await testPrisma.$executeRaw`UPDATE jobs SET dispatched_at = now() - interval '1 hour' WHERE id = ${jobId}::uuid`;

      await moduleRef.get(JobReconcilerService).reconcile();

      expect(await job(jobId)).toMatchObject({ status: 'queued', dispatch_count: 2 });
    });

    it.each([
      ['whose worker died', (jobId: string) => expireLease(jobId, 1)],
      [
        'nobody picked up',
        (jobId: string) =>
          testPrisma.$executeRaw`UPDATE jobs SET dispatched_at = now() - interval '1 hour' WHERE id = ${jobId}::uuid`,
      ],
    ])('keeps the request id of the request that created a job %s', async (_case, makeStuck) => {
      const jobId = await createJob();
      await testPrisma.jobOutboxMessage.updateMany({ where: { job_id: jobId }, data: { request_id: REQUEST_ID } });
      await makeStuck(jobId);

      await moduleRef.get(JobReconcilerService).reconcile();

      const messages = await testPrisma.jobOutboxMessage.findMany({ where: { job_id: jobId } });
      expect(messages.map((message) => message.request_id)).toEqual([REQUEST_ID, REQUEST_ID]);
    });

    it('counts only dispatches nobody picked up: a job taken by a worker starts counting again', async () => {
      const jobId = await createJob('flaky deneme');
      // Earlier unpicked dispatches, then a worker takes the job and its attempt fails transiently.
      await testPrisma.$executeRaw`UPDATE jobs SET dispatch_count = 4 WHERE id = ${jobId}::uuid`;
      const done = processor.process(jobId, REQUEST_ID);
      await waitFor(() => provider.pending === 1);
      provider.fail(new TransientAiError('busy'));
      await done;
      // The retry's message is lost.
      await testPrisma.$executeRaw`
        UPDATE jobs SET dispatched_at = now() - interval '1 hour', run_after = now() - interval '1 hour'
         WHERE id = ${jobId}::uuid`;

      await moduleRef.get(JobReconcilerService).reconcile();

      expect(await job(jobId)).toMatchObject({ status: 'queued', dispatch_count: 2 });
    });

    it('leaves alone a job a worker has received, however long it waits for a provider permit', async () => {
      const ids = [];
      for (const text of ['metin 1', 'metin 2', 'metin 3', 'metin 4', 'metin 5']) {
        ids.push(await createJob(text));
      }
      const done = Promise.all(ids.map((id) => processor.process(id, REQUEST_ID)));
      await waitFor(() => provider.pending === 4);
      const waiting = await testPrisma.job.findFirstOrThrow({ where: { id: { in: ids }, status: 'queued' } });
      await testPrisma.$executeRaw`UPDATE jobs SET dispatched_at = now() - interval '1 hour' WHERE id = ${waiting.id}::uuid`;

      await moduleRef.get(JobReconcilerService).reconcile();

      expect(await job(waiting.id)).toMatchObject({ status: 'queued', dispatch_count: 0 });
      expect(await testPrisma.jobOutboxMessage.count({ where: { job_id: waiting.id } })).toBe(1);
      provider.respond();
      await waitFor(() => provider.pending === 1);
      provider.respond();
      await done;
      expect(await job(waiting.id)).toMatchObject({ status: 'completed' });
    });

    it('keeps re-sending a job nobody received, waiting longer each time, and never fails it for that', async () => {
      const jobId = await createJob();
      // Five sends nobody received; the next waits 2 min × 2^4 = 32 min.
      await testPrisma.$executeRaw`
        UPDATE jobs SET dispatched_at = now() - interval '33 minutes', dispatch_count = 5 WHERE id = ${jobId}::uuid`;
      await moduleRef.get(JobReconcilerService).reconcile();
      expect(await job(jobId)).toMatchObject({ status: 'queued', dispatch_count: 6 });

      // The gap is capped at an hour: 59 minutes after the sixth send, still too early.
      await testPrisma.$executeRaw`UPDATE jobs SET dispatched_at = now() - interval '59 minutes' WHERE id = ${jobId}::uuid`;
      await moduleRef.get(JobReconcilerService).reconcile();
      expect(await job(jobId)).toMatchObject({ status: 'queued', dispatch_count: 6 });
      expect((await creditState('user-1')).reserved).toBe(3);
    });
  });

  // Stopping a processor is for good, so every test here gets a new module afterwards.
  describe('shutdown', () => {
    afterEach(async () => {
      await moduleRef.close();
      await createModule();
    });

    it('gives a waiting job back untouched when the worker stops taking jobs', async () => {
      const { done } = await fillPermits();

      processor.stopTakingJobs();
      provider.respond();
      const results = await done;

      // Four jobs finished; the fifth was never claimed and is delivered again.
      expect(results.filter((handled) => !handled)).toHaveLength(1);
      expect(await unclaimed()).toBe(1);
      expect(await testPrisma.job.count({ where: { status: 'completed' } })).toBe(4);
    });

    it('returns a running job to the queue on shutdown without counting the attempt', async () => {
      const jobId = await createJob();
      const done = processor.process(jobId, REQUEST_ID);
      await waitFor(() => provider.pending === 1);

      processor.interruptInFlight();
      await done;

      expect(await job(jobId)).toMatchObject({ status: 'queued', attempt_count: 0, lock_token: null });
      expect((await creditState('user-1')).reserved).toBe(3);
    });
  });
});
