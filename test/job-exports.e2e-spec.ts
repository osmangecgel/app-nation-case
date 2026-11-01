import { HttpStatus } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { ExportAdmissionService } from '#modules/job-exports/export-admission.service.ts';
import { JobExportRunService } from '#modules/job-exports/job-export-run.service.ts';
import { createTestApp } from './support/test-app.ts';
import { testPrisma } from './support/test-prisma.ts';

const REQUEST_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const CSV_HEADER = 'job_id,type,status,cost,error_code,created_at,finished_at\r\n';

describe('CSV exports', () => {
  let app: NestExpressApplication;
  let runs: JobExportRunService;
  const http = () => request(app.getHttpServer());
  const asUser = (method: 'get' | 'post' | 'delete', path: string, userId = 'user-1') =>
    http()[method](path).set('X-User-Id', userId);
  const running = () => new AbortController().signal;

  async function userWithJobs(userId: string, count: number): Promise<void> {
    await http().post(`/internal/users/${userId}/credits`).send({ amount: 100 }).expect(HttpStatus.OK);
    for (let index = 0; index < count; index += 1) {
      await asUser('post', '/v1/jobs', userId)
        .set('Idempotency-Key', `key-${index}`)
        .send({ type: 'translate', input: `metin ${index}` })
        .expect(HttpStatus.ACCEPTED);
    }
  }

  async function requestExport(userId = 'user-1'): Promise<string> {
    const response = await asUser('post', '/v1/exports', userId).expect(HttpStatus.ACCEPTED);
    return response.body.exportId;
  }

  const exportRow = (id: string) => testPrisma.jobExport.findUniqueOrThrow({ where: { id } });

  beforeAll(async () => {
    app = await createTestApp();
    runs = app.get(JobExportRunService);
  });

  afterAll(async () => {
    await app.close();
    await testPrisma.$disconnect();
  });

  describe('background export (Asynchronous Request-Reply)', () => {
    it('accepts a request with 202, Location and Retry-After, and dispatches it through the outbox', async () => {
      await userWithJobs('user-1', 2);

      const response = await asUser('post', '/v1/exports').expect(HttpStatus.ACCEPTED);

      expect(response.body).toMatchObject({ status: 'queued', rowCount: null, finishedAt: null });
      expect(response.headers.location).toBe(`/v1/exports/${response.body.exportId}`);
      expect(response.headers['retry-after']).toBe('5');
      const message = await testPrisma.jobOutboxMessage.findFirstOrThrow({
        where: { export_id: response.body.exportId },
      });
      expect(message).toMatchObject({ topic: 'exports.process', job_id: null });
    });

    it('returns the unfinished export to a second request instead of preparing another', async () => {
      await userWithJobs('user-1', 1);
      const first = await requestExport();

      const second = await requestExport();

      expect(second).toBe(first);
      expect(await testPrisma.jobExport.count()).toBe(1);
    });

    it('prepares the file, then sends the client to it with 303', async () => {
      await userWithJobs('user-1', 3);
      const exportId = await requestExport();

      expect(await runs.process(exportId, REQUEST_ID, running())).toBe(true);

      expect(await exportRow(exportId)).toMatchObject({ status: 'ready', row_count: 3, lock_token: null });
      const status = await asUser('get', `/v1/exports/${exportId}`).expect(HttpStatus.SEE_OTHER);
      expect(status.headers.location).toBe(`/v1/exports/${exportId}/file`);
      const file = await asUser('get', `/v1/exports/${exportId}/file`).expect(HttpStatus.OK);
      const streamed = await asUser('get', '/v1/jobs/export.csv').expect(HttpStatus.OK);
      expect(file.text.startsWith(CSV_HEADER)).toBe(true);
      expect(file.text).toBe(streamed.text);
    });

    it('returns a file made in the last minutes again instead of making it twice', async () => {
      await userWithJobs('user-1', 1);
      const exportId = await requestExport();
      await runs.process(exportId, REQUEST_ID, running());

      const again = await asUser('post', '/v1/exports').expect(HttpStatus.ACCEPTED);

      expect(again.body).toMatchObject({ exportId, status: 'ready' });
    });

    it('tells the client to poll again while the export is being prepared', async () => {
      await userWithJobs('user-1', 1);
      const exportId = await requestExport();

      const status = await asUser('get', `/v1/exports/${exportId}`).expect(HttpStatus.OK);

      expect(status.body.status).toBe('queued');
      expect(status.headers['retry-after']).toBe('5');
      await asUser('get', `/v1/exports/${exportId}/file`).expect(HttpStatus.NOT_FOUND);
    });

    it("hides another user's export, and a malformed id, as not found", async () => {
      await userWithJobs('user-1', 1);
      const exportId = await requestExport();

      await asUser('get', `/v1/exports/${exportId}`, 'someone-else').expect(HttpStatus.NOT_FOUND);
      await asUser('get', '/v1/exports/not-an-id').expect(HttpStatus.NOT_FOUND);
    });

    it('cancels an unfinished export, after which no worker prepares it', async () => {
      await userWithJobs('user-1', 1);
      const exportId = await requestExport();

      const canceled = await asUser('delete', `/v1/exports/${exportId}`).expect(HttpStatus.OK);
      await runs.process(exportId, REQUEST_ID, running());

      expect(canceled.body.status).toBe('canceled');
      expect(await exportRow(exportId)).toMatchObject({ status: 'canceled', file_key: null });
    });

    it('gives a message back untouched when the worker is already stopping', async () => {
      await userWithJobs('user-1', 1);
      const exportId = await requestExport();

      expect(await runs.process(exportId, REQUEST_ID, AbortSignal.abort())).toBe(false);
      expect(await exportRow(exportId)).toMatchObject({ status: 'queued', attempt_count: 0 });
    });

    it('stops serving a file once it expires, before maintenance has deleted it', async () => {
      await userWithJobs('user-1', 1);
      const exportId = await requestExport();
      await runs.process(exportId, REQUEST_ID, running());
      await testPrisma.$executeRaw`UPDATE job_exports SET expires_at = now() - interval '1 second' WHERE id = ${exportId}::uuid`;

      const file = await asUser('get', `/v1/exports/${exportId}/file`).expect(HttpStatus.NOT_FOUND);

      expect(file.body.code).toBe('EXPORT_FILE_NOT_FOUND');
    });

    it('answers 404 for a user with nothing to export', async () => {
      await asUser('post', '/v1/exports', 'nobody').expect(HttpStatus.NOT_FOUND);
    });
  });

  describe('maintenance', () => {
    const expireLease = (exportId: string, attemptCount: number) => testPrisma.$executeRaw`
      UPDATE job_exports SET status = 'processing', attempt_count = ${attemptCount}, lock_token = gen_random_uuid(),
                             locked_until = now() - interval '1 second'
       WHERE id = ${exportId}::uuid`;

    it('puts an export whose worker died back in the queue', async () => {
      await userWithJobs('user-1', 1);
      const exportId = await requestExport();
      await expireLease(exportId, 1);

      await runs.maintain();

      expect(await exportRow(exportId)).toMatchObject({ status: 'queued', lock_token: null, dispatch_count: 1 });
      expect(await testPrisma.jobOutboxMessage.count({ where: { export_id: exportId } })).toBe(2);
    });

    it('fails an export whose worker died during its last attempt', async () => {
      await userWithJobs('user-1', 1);
      const exportId = await requestExport();
      await expireLease(exportId, 3);

      await runs.maintain();

      expect(await exportRow(exportId)).toMatchObject({ status: 'failed', error_code: 'worker_lost' });
    });

    it('deletes the file of an expired export and stops serving it', async () => {
      await userWithJobs('user-1', 1);
      const exportId = await requestExport();
      await runs.process(exportId, REQUEST_ID, running());
      await testPrisma.$executeRaw`UPDATE job_exports SET expires_at = now() - interval '1 second' WHERE id = ${exportId}::uuid`;

      await runs.maintain();

      expect(await exportRow(exportId)).toMatchObject({ status: 'expired', file_key: null });
      const file = await asUser('get', `/v1/exports/${exportId}/file`).expect(HttpStatus.NOT_FOUND);
      expect(file.body.code).toBe('EXPORT_FILE_NOT_FOUND');
    });
  });

  describe('streamed export admission', () => {
    it('refuses a second streamed export of the same user with 429 and Retry-After', async () => {
      await userWithJobs('user-1', 1);
      const running = await app.get(ExportAdmissionService).admit('user-1', new AbortController().signal);

      const refused = await asUser('get', '/v1/jobs/export.csv').expect(HttpStatus.TOO_MANY_REQUESTS);

      expect(refused.body).toMatchObject({ code: 'EXPORT_IN_PROGRESS', error: 'export_in_progress' });
      expect(refused.headers['retry-after']).toBe('10');
      await running.release();
      await asUser('get', '/v1/jobs/export.csv').expect(HttpStatus.OK);
    });
  });
});
