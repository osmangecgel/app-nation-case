import { HttpStatus } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { creditState } from './support/credits.ts';
import { createTestApp } from './support/test-app.ts';
import { testPrisma } from './support/test-prisma.ts';

const SUMMARY = { type: 'summary', input: 'Merhaba dünya' };
const UUID = /^[0-9a-f-]{36}$/;

describe('Jobs API', () => {
  let app: NestExpressApplication;

  const grant = (userId: string, amount: number): request.Test =>
    request(app.getHttpServer()).post(`/internal/users/${userId}/credits`).send({ amount });

  const createJob = (userId: string, key: string, body: object = SUMMARY): request.Test =>
    request(app.getHttpServer()).post('/v1/jobs').set('X-User-Id', userId).set('Idempotency-Key', key).send(body);

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await testPrisma.$disconnect();
  });

  describe('POST /v1/jobs', () => {
    it('reserves the cost, queues the job and returns 202', async () => {
      await grant('user-1', 10);

      const response = await createJob('user-1', 'key-1').expect(HttpStatus.ACCEPTED);

      expect(response.body).toEqual({ jobId: expect.stringMatching(UUID), status: 'queued' });
      expect(await creditState('user-1')).toEqual({ balance: 7, reserved: 3, ledgerBalance: 7, ledgerReserved: 3 });
      const job = await testPrisma.job.findUniqueOrThrow({
        where: { id: response.body.jobId },
        include: { content: true },
      });
      expect(job).toMatchObject({
        status: 'queued',
        cost: 3,
        job_provider_code: 'fake-text',
        model_version: 'fake-v1',
      });
      expect(job.content).toMatchObject({ job_type_code: 'summary', input: 'merhaba dünya' });
      expect(await testPrisma.jobOutboxMessage.count({ where: { job_id: job.id, sent_at: null } })).toBe(1);
    });

    // As Python's json.dumps sends them: every character escaped. A letter like ç
    // is \u00e7 (6 bytes); an emoji is a surrogate pair, \ud83d\ude00 (12 bytes).
    it.each([
      ['ç', '\\u00e7'],
      ['an emoji', '\\ud83d\\ude00'],
    ])('accepts the longest input from a client that escapes every character: %s', async (_case, escaped) => {
      await grant('user-1', 10);
      const body = `{"type":"translate","input":"${escaped.repeat(20_000)}"}`;

      await request(app.getHttpServer())
        .post('/v1/jobs')
        .set('X-User-Id', 'user-1')
        .set('Idempotency-Key', 'escaped')
        .set('Content-Type', 'application/json')
        .send(body)
        .expect(HttpStatus.ACCEPTED);
    });

    it('charges the price of the job type', async () => {
      await grant('user-1', 10);

      await createJob('user-1', 'key-1', { type: 'translate', input: 'merhaba' }).expect(HttpStatus.ACCEPTED);

      expect((await creditState('user-1')).balance).toBe(9);
    });

    it('returns the first response for a retry with the same key and body', async () => {
      await grant('user-1', 10);
      const first = await createJob('user-1', 'key-1');

      const retry = await createJob('user-1', 'key-1').expect(HttpStatus.ACCEPTED);

      expect(retry.body).toEqual(first.body);
      expect(await testPrisma.job.count()).toBe(1);
      expect((await creditState('user-1')).balance).toBe(7);
    });

    it('rejects the same key with a different body with 422', async () => {
      await grant('user-1', 10);
      await createJob('user-1', 'key-1');

      const response = await createJob('user-1', 'key-1', { ...SUMMARY, input: 'Başka metin' }).expect(
        HttpStatus.UNPROCESSABLE_ENTITY,
      );

      expect(response.body).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', error: 'idempotency_key_reused' });
      expect(await testPrisma.job.count()).toBe(1);
    });

    it('treats the same key from another user as a different request', async () => {
      await grant('user-1', 10);
      await grant('user-2', 10);

      const first = await createJob('user-1', 'key-1');
      const second = await createJob('user-2', 'key-1').expect(HttpStatus.ACCEPTED);

      expect(second.body.jobId).not.toBe(first.body.jobId);
    });

    it('accepts a key again once it has expired', async () => {
      await grant('user-1', 10);
      const first = await createJob('user-1', 'key-1');
      await testPrisma.$executeRaw`UPDATE job_idempotency_keys SET created_at = now() - interval '2 days', expires_at = now() - interval '1 day'`;

      const second = await createJob('user-1', 'key-1').expect(HttpStatus.ACCEPTED);

      expect(second.body.jobId).not.toBe(first.body.jobId);
      expect((await creditState('user-1')).balance).toBe(4);
    });

    it('rejects a job without enough credits with 402 and creates nothing', async () => {
      await grant('user-1', 2);

      const response = await createJob('user-1', 'key-1').expect(HttpStatus.PAYMENT_REQUIRED);

      expect(response.body).toMatchObject({ code: 'INSUFFICIENT_CREDITS', error: 'insufficient_credits' });
      expect(await testPrisma.job.count()).toBe(0);
      expect(await testPrisma.jobIdempotencyKey.count()).toBe(0);
      expect(await testPrisma.jobContent.count()).toBe(0);
    });

    it('rejects a user who never received credits with 402', async () => {
      await createJob('nobody', 'key-1').expect(HttpStatus.PAYMENT_REQUIRED);
    });

    it('lets a rejected request be retried with the same key after a top-up', async () => {
      await grant('user-1', 2);
      await createJob('user-1', 'key-1').expect(HttpStatus.PAYMENT_REQUIRED);
      await grant('user-1', 1);

      await createJob('user-1', 'key-1').expect(HttpStatus.ACCEPTED);
    });

    it('rejects a user with too many unfinished jobs with 429', async () => {
      await grant('user-1', 10);
      await testPrisma.user.update({ where: { id: 'user-1' }, data: { active_job_count: 50 } });

      const response = await createJob('user-1', 'key-1').expect(HttpStatus.TOO_MANY_REQUESTS);

      expect(response.body.code).toBe('TOO_MANY_ACTIVE_JOBS');
      expect((await creditState('user-1')).balance).toBe(10);
    });

    it('shares one content row between users with the same normalised input', async () => {
      await grant('user-1', 10);
      await grant('user-2', 10);

      await createJob('user-1', 'key-1', { type: 'summary', input: 'Merhaba   Dünya' });
      await createJob('user-2', 'key-1', { type: 'summary', input: ' merhaba dünya ' });
      await createJob('user-2', 'key-2', { type: 'translate', input: 'merhaba dünya' });

      expect(await testPrisma.job.count()).toBe(3);
      expect(await testPrisma.jobContent.count()).toBe(2);
    });

    it('returns 401 without X-User-Id', async () => {
      const response = await request(app.getHttpServer())
        .post('/v1/jobs')
        .set('Idempotency-Key', 'key-1')
        .send(SUMMARY)
        .expect(HttpStatus.UNAUTHORIZED);

      expect(response.body.code).toBe('USER_ID_REQUIRED');
    });

    it('returns 400 without Idempotency-Key', async () => {
      const response = await request(app.getHttpServer())
        .post('/v1/jobs')
        .set('X-User-Id', 'user-1')
        .send(SUMMARY)
        .expect(HttpStatus.BAD_REQUEST);

      expect(response.body.errors).toEqual([
        { field: 'Idempotency-Key', code: 'REQUIRED', message: expect.any(String) },
      ]);
    });

    it.each([
      ['an unknown type', { type: 'image', input: 'x' }, 'type', 'INVALID_VALUE'],
      ['a blank input', { type: 'summary', input: '   ' }, 'input', 'TOO_SMALL'],
      ['an input over 20,000 characters', { type: 'summary', input: 'a'.repeat(20_001) }, 'input', 'TOO_BIG'],
      ['a missing input', { type: 'summary' }, 'input', 'REQUIRED'],
      ['an input with a NUL character', { type: 'summary', input: 'a\u0000b' }, 'input', 'INVALID_VALUE'],
    ])('returns 400 for %s', async (_case, body, field, code) => {
      await grant('user-1', 10);

      const response = await createJob('user-1', 'key-1', body).expect(HttpStatus.BAD_REQUEST);

      expect(response.body).toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(response.body.errors).toEqual([{ field, code, message: expect.any(String) }]);
    });

    it('counts characters, not UTF-16 units: 20,000 emoji fit the limit', async () => {
      await grant('user-1', 10);

      await createJob('user-1', 'key-1', { type: 'summary', input: '😀'.repeat(20_000) }).expect(HttpStatus.ACCEPTED);
    });
  });

  // The case's automated tests (a) and (b).
  describe('concurrency', () => {
    it('(a) 10 concurrent requests with the same key create one job and one reservation', async () => {
      await grant('user-1', 10);

      const responses = await Promise.all(Array.from({ length: 10 }, () => createJob('user-1', 'same-key')));

      expect(responses.map((response) => response.status)).toEqual(Array(10).fill(HttpStatus.ACCEPTED));
      expect(new Set(responses.map((response) => response.body.jobId)).size).toBe(1);
      expect(await testPrisma.job.count()).toBe(1);
      expect(await testPrisma.userCreditLedgerEntry.count({ where: { entry_type: 'reserve' } })).toBe(1);
      expect(await creditState('user-1')).toEqual({ balance: 7, reserved: 3, ledgerBalance: 7, ledgerReserved: 3 });
    });

    it('(b) 5 concurrent 3-credit requests on a balance of 5: at most one succeeds', async () => {
      await grant('user-1', 5);

      const responses = await Promise.all(
        Array.from({ length: 5 }, (_, index) =>
          createJob('user-1', `key-${index}`, { type: 'summary', input: `metin ${index}` }),
        ),
      );

      const statuses = responses.map((response) => response.status);
      expect(statuses.filter((status) => status === HttpStatus.ACCEPTED)).toHaveLength(1);
      expect(statuses.filter((status) => status === HttpStatus.PAYMENT_REQUIRED)).toHaveLength(4);
      expect(await testPrisma.job.count()).toBe(1);
      expect(await creditState('user-1')).toEqual({ balance: 2, reserved: 3, ledgerBalance: 2, ledgerReserved: 3 });
    });
  });

  describe('GET /v1/jobs/:id', () => {
    it('returns the job of the caller', async () => {
      await grant('user-1', 10);
      const { body } = await createJob('user-1', 'key-1');

      const response = await request(app.getHttpServer())
        .get(`/v1/jobs/${body.jobId}`)
        .set('X-User-Id', 'user-1')
        .expect(HttpStatus.OK);

      expect(response.body).toEqual({
        jobId: body.jobId,
        type: 'summary',
        status: 'queued',
        result: null,
        errorCode: null,
        cost: 3,
        createdAt: expect.any(String),
        finishedAt: null,
      });
    });

    it.each([
      ['another user’s job', 'user-2', null],
      ['a malformed id', 'user-1', 'not-a-uuid'],
      ['an unknown id', 'user-1', '0192f3a1-7c4e-7b2a-9d1f-3e5a8b6c2d10'],
    ])('returns 404 for %s', async (_case, caller, id) => {
      await grant('user-1', 10);
      const { body } = await createJob('user-1', 'key-1');

      const response = await request(app.getHttpServer())
        .get(`/v1/jobs/${id ?? body.jobId}`)
        .set('X-User-Id', caller)
        .expect(HttpStatus.NOT_FOUND);

      expect(response.body.code).toBe('JOB_NOT_FOUND');
    });
  });

  describe('GET /v1/jobs', () => {
    it('lists the caller’s jobs newest first, page by page', async () => {
      await grant('user-1', 10);
      const created = [];
      for (const index of [0, 1, 2]) {
        created.push(
          (await createJob('user-1', `key-${index}`, { type: 'translate', input: `metin ${index}` })).body.jobId,
        );
      }

      const first = await request(app.getHttpServer())
        .get('/v1/jobs?limit=2')
        .set('X-User-Id', 'user-1')
        .expect(HttpStatus.OK);
      const second = await request(app.getHttpServer())
        .get(`/v1/jobs?limit=2&cursor=${first.body.pagination.nextCursor}`)
        .set('X-User-Id', 'user-1')
        .expect(HttpStatus.OK);

      expect(first.body.data.map((job: { jobId: string }) => job.jobId)).toEqual([created[2], created[1]]);
      expect(first.body.pagination.hasMore).toBe(true);
      expect(second.body.data.map((job: { jobId: string }) => job.jobId)).toEqual([created[0]]);
      expect(second.body.pagination).toEqual({ nextCursor: null, hasMore: false });
    });

    it('filters by status and shows only the caller’s jobs', async () => {
      await grant('user-1', 10);
      await grant('user-2', 10);
      await createJob('user-1', 'key-1');
      await createJob('user-2', 'key-1');

      const queued = await request(app.getHttpServer())
        .get('/v1/jobs?status=queued')
        .set('X-User-Id', 'user-1')
        .expect(HttpStatus.OK);
      const completed = await request(app.getHttpServer())
        .get('/v1/jobs?status=completed')
        .set('X-User-Id', 'user-1')
        .expect(HttpStatus.OK);

      expect(queued.body.data).toHaveLength(1);
      expect(completed.body.data).toHaveLength(0);
    });

    it('treats empty parameters as not given, so ?status=&limit=&cursor= is the first page', async () => {
      await grant('user-1', 10);
      await createJob('user-1', 'key-1', SUMMARY).expect(HttpStatus.ACCEPTED);

      const response = await request(app.getHttpServer())
        .get('/v1/jobs?status=&limit=&cursor=')
        .set('X-User-Id', 'user-1')
        .expect(HttpStatus.OK);

      expect(response.body.data).toHaveLength(1);
      expect(response.body.pagination).toEqual({ nextCursor: null, hasMore: false });
    });

    it.each([['limit=101'], ['status=done'], ['cursor=not-a-cursor']])('returns 400 for %s', async (query) => {
      await request(app.getHttpServer())
        .get(`/v1/jobs?${query}`)
        .set('X-User-Id', 'user-1')
        .expect(HttpStatus.BAD_REQUEST);
    });
  });

  describe('GET /v1/jobs/export.csv', () => {
    it('streams every job of the caller as CSV, newest first', async () => {
      await grant('user-1', 10);
      const first = await createJob('user-1', 'key-1', { type: 'translate', input: 'bir' });
      const second = await createJob('user-1', 'key-2', { type: 'summary', input: 'iki' });

      const response = await request(app.getHttpServer())
        .get('/v1/jobs/export.csv')
        .set('X-User-Id', 'user-1')
        .expect(HttpStatus.OK)
        .expect('content-type', /text\/csv/)
        .expect('content-disposition', /attachment/);

      const lines = response.text.split('\r\n').filter((line) => line !== '');
      expect(lines[0]).toBe('job_id,type,status,cost,error_code,created_at,finished_at');
      expect(lines.slice(1).map((line) => line.split(',').slice(0, 4))).toEqual([
        [second.body.jobId, 'summary', 'queued', '3'],
        [first.body.jobId, 'translate', 'queued', '1'],
      ]);
    });

    it('returns only the header for a user without jobs', async () => {
      const response = await request(app.getHttpServer())
        .get('/v1/jobs/export.csv')
        .set('X-User-Id', 'user-1')
        .expect(HttpStatus.OK);

      expect(response.text).toBe('job_id,type,status,cost,error_code,created_at,finished_at\r\n');
    });
  });
});
