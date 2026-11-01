import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '#core/config/env.validation.ts';
import { generateRequestId } from '#core/context/request-id.ts';
import { PrismaService } from '#infra/database/prisma.service.ts';
import { FileStore, type FileUpload } from '#infra/file-store/file-store.ts';
import { JobOutboxService } from '#modules/job-outbox/job-outbox.service.ts';
import type { Prisma } from '#generated/prisma/client.ts';
import { describeError } from '#shared/describe-error.ts';
import { JobExportService } from './job-export.service.ts';
import { exportFileKey } from './job-exports.service.ts';
import {
  EXPORT_MAINTENANCE_BATCH_SIZE,
  EXPORT_MAX_ATTEMPTS,
  EXPORT_MAX_REDISPATCH_WAIT_MS,
  EXPORT_RETRY_BASE_DELAY_MS,
  ExportFailureCode,
  JobExportLogEvent,
} from './job-exports.constants.ts';

// The database refuses more; an export that keeps losing its lease fails well before.
const ATTEMPT_COUNT_LIMIT = 10;

type Claimed = { userId: string; attemptCount: number };

// One claimed attempt, with what settling it needs.
type Run = { exportId: string; token: string; requestId: string; attemptCount: number };

// Background CSV exports, the worker side. The same safety as for jobs: the
// export is claimed with a conditional UPDATE and a lock_token (fencing
// token), the lease is extended while the file is written, and every write
// requires the token, so a worker that lost the export (taken over, or
// canceled by the user) changes nothing. maintain() is the reconciler.
@Injectable()
export class JobExportRunService {
  private readonly logger = new Logger(JobExportRunService.name);
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;
  private readonly fileTtlMs: number;
  private readonly staleMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobExport: JobExportService,
    private readonly files: FileStore,
    private readonly outbox: JobOutboxService,
    config: ConfigService<Env, true>,
  ) {
    this.leaseMs = config.get('WORKER_LEASE_MS', { infer: true });
    this.heartbeatMs = config.get('WORKER_HEARTBEAT_MS', { infer: true });
    this.fileTtlMs = config.get('EXPORT_FILE_TTL_MS', { infer: true });
    this.staleMs = config.get('RECONCILER_STALE_QUEUED_MS', { infer: true });
  }

  // Prepares the export's file. False when it was given up before the claim
  // (the worker is stopping): nothing was written, deliver the message again.
  // `stop` aborts on shutdown: a claimed export goes back to the queue.
  async process(exportId: string, requestId: string, stop: AbortSignal): Promise<boolean> {
    if (stop.aborted) {
      return false;
    }
    const token = randomUUID();
    const claimed = await this.claim(exportId, token);
    if (!claimed) {
      return true;
    }
    const run: Run = { exportId, token, requestId, attemptCount: claimed.attemptCount };
    if (claimed.attemptCount > EXPORT_MAX_ATTEMPTS) {
      await this.fail(run, ExportFailureCode.WORKER_LOST);
      return true;
    }
    this.logger.log(JobExportLogEvent.EXPORT_STARTED, { exportId, attempt: claimed.attemptCount });
    const lost = new AbortController();
    const heartbeat = setInterval(() => void this.renew(run, lost), this.heartbeatMs);
    try {
      await this.write(run, claimed.userId, lost.signal, stop);
    } finally {
      clearInterval(heartbeat);
    }
    return true;
  }

  // The reconciler, run by every worker; SKIP LOCKED keeps two off the same row.
  async maintain(): Promise<void> {
    await this.recoverExpiredLeases();
    await this.redispatchUnreceived();
    await this.deleteExpiredFiles();
  }

  private async write(run: Run, userId: string, lost: AbortSignal, stop: AbortSignal): Promise<void> {
    const key = exportFileKey(run.exportId);
    let upload: FileUpload | undefined;
    try {
      upload = await this.files.upload(key);
      const rows = await this.jobExport.writeRows(userId, upload.stream, () => lost.aborted || stop.aborted);
      if (lost.aborted || stop.aborted) {
        await upload.abort();
        if (!lost.aborted) {
          await this.returnToQueue(run);
        }
        return;
      }
      await upload.commit();
      await this.markReady(run, key, rows);
    } catch (error) {
      await upload?.abort();
      await this.retryOrFail(run, describeError(error));
    }
  }

  // Receiving and claiming are one step here: the consumer starts an export
  // only when a slot is free, so dispatch_count goes back to 0 at once.
  private async claim(exportId: string, token: string): Promise<Claimed | null> {
    const [row] = await this.prisma.$queryRaw<{ user_id: string; attempt_count: number }[]>`
      UPDATE job_exports
         SET status = 'processing', attempt_count = attempt_count + 1, lock_token = ${token}::uuid,
             locked_until = now() + make_interval(secs => ${this.leaseMs / 1000}::double precision),
             dispatch_count = 0, updated_at = now()
       WHERE id = ${exportId}::uuid AND attempt_count < ${ATTEMPT_COUNT_LIMIT}::int
         AND ((status = 'queued' AND (attempt_count = 0 OR run_after <= now()))
              OR (status = 'processing' AND locked_until < now()))
      RETURNING user_id, attempt_count`;
    return row ? { userId: row.user_id, attemptCount: row.attempt_count } : null;
  }

  // A canceled or taken-over export loses its lease here, and the writing stops.
  private async renew(run: Run, lost: AbortController): Promise<void> {
    try {
      const count = await this.prisma.$executeRaw`
        UPDATE job_exports
           SET locked_until = now() + make_interval(secs => ${this.leaseMs / 1000}::double precision), updated_at = now()
         WHERE id = ${run.exportId}::uuid AND lock_token = ${run.token}::uuid AND status = 'processing'`;
      if (count === 0) {
        lost.abort(new Error('Export lease lost.'));
      }
    } catch (error) {
      // Not proof the lease is gone; the next beat tries again.
      this.logger.warn(JobExportLogEvent.EXPORT_LEASE_EXTEND_FAILED, {
        exportId: run.exportId,
        reason: describeError(error),
      });
    }
  }

  // The file is only kept if the export is still ours (not canceled meanwhile).
  private async markReady(run: Run, key: string, rows: number): Promise<void> {
    const count = await this.prisma.$executeRaw`
      UPDATE job_exports
         SET status = 'ready', file_key = ${key}, row_count = ${rows}::int, finished_at = now(),
             expires_at = now() + make_interval(secs => ${this.fileTtlMs / 1000}::double precision),
             lock_token = NULL, locked_until = NULL, updated_at = now()
       WHERE id = ${run.exportId}::uuid AND lock_token = ${run.token}::uuid AND status = 'processing'`;
    if (count === 0) {
      await this.files.delete(key);
      return;
    }
    this.logger.log(JobExportLogEvent.EXPORT_READY, { exportId: run.exportId, rows });
  }

  private async retryOrFail(run: Run, reason: string): Promise<void> {
    if (run.attemptCount >= EXPORT_MAX_ATTEMPTS) {
      await this.fail(run, ExportFailureCode.EXPORT_FAILED);
      return;
    }
    const delayMs = EXPORT_RETRY_BASE_DELAY_MS * 2 ** (run.attemptCount - 1);
    await this.prisma.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<{ run_after: Date }[]>`
        UPDATE job_exports
           SET status = 'queued', run_after = now() + make_interval(secs => ${delayMs / 1000}::double precision),
               lock_token = NULL, locked_until = NULL, dispatched_at = now(), dispatch_count = 1, updated_at = now()
         WHERE id = ${run.exportId}::uuid AND lock_token = ${run.token}::uuid AND status = 'processing'
        RETURNING run_after`;
      if (row) {
        await this.outbox.enqueueExport(tx, {
          exportId: run.exportId,
          requestId: run.requestId,
          notBefore: row.run_after,
        });
      }
    });
    this.logger.warn(JobExportLogEvent.EXPORT_RETRY_SCHEDULED, {
      exportId: run.exportId,
      attempt: run.attemptCount,
      delayMs,
      reason,
    });
  }

  private async fail(run: Run, errorCode: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE job_exports
         SET status = 'failed', error_code = ${errorCode}, finished_at = now(),
             lock_token = NULL, locked_until = NULL, updated_at = now()
       WHERE id = ${run.exportId}::uuid AND lock_token = ${run.token}::uuid AND status = 'processing'`;
    this.logger.warn(JobExportLogEvent.EXPORT_FAILED, { exportId: run.exportId, errorCode, attempt: run.attemptCount });
  }

  // Shutdown stopped the export before its file was done: the attempt does not count.
  private async returnToQueue(run: Run): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const count = await tx.$executeRaw`
        UPDATE job_exports
           SET status = 'queued', attempt_count = greatest(attempt_count - 1, 0), run_after = now(),
               lock_token = NULL, locked_until = NULL, dispatched_at = now(), dispatch_count = 1, updated_at = now()
         WHERE id = ${run.exportId}::uuid AND lock_token = ${run.token}::uuid AND status = 'processing'`;
      if (count > 0) {
        await this.outbox.enqueueExport(tx, { exportId: run.exportId, requestId: run.requestId });
      }
    });
    this.logger.log(JobExportLogEvent.EXPORT_RETURNED_TO_QUEUE, { exportId: run.exportId });
  }

  // A worker died while writing: back to the queue, or failed after the last attempt.
  private async recoverExpiredLeases(): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string; attempt_count: number }[]>`
        SELECT id, attempt_count FROM job_exports
         WHERE status = 'processing' AND locked_until < now()
         ORDER BY locked_until
         LIMIT ${EXPORT_MAINTENANCE_BATCH_SIZE}::int
           FOR UPDATE SKIP LOCKED`;
      for (const row of rows) {
        await this.recoverExpired(tx, row.id, row.attempt_count);
      }
    });
  }

  private async recoverExpired(tx: Prisma.TransactionClient, exportId: string, attemptCount: number): Promise<void> {
    if (attemptCount >= EXPORT_MAX_ATTEMPTS) {
      await tx.$executeRaw`
        UPDATE job_exports
           SET status = 'failed', error_code = ${ExportFailureCode.WORKER_LOST}, finished_at = now(),
               lock_token = NULL, locked_until = NULL, updated_at = now()
         WHERE id = ${exportId}::uuid AND status = 'processing' AND locked_until < now()`;
      this.logger.warn(JobExportLogEvent.EXPORT_FAILED, { exportId, errorCode: ExportFailureCode.WORKER_LOST });
      return;
    }
    const count = await tx.$executeRaw`
      UPDATE job_exports
         SET status = 'queued', run_after = now(), lock_token = NULL, locked_until = NULL,
             dispatched_at = now(), dispatch_count = 1, updated_at = now()
       WHERE id = ${exportId}::uuid AND status = 'processing' AND locked_until < now()`;
    if (count > 0) {
      await this.outbox.enqueueExport(tx, { exportId, requestId: generateRequestId() });
      this.logger.warn(JobExportLogEvent.EXPORT_LEASE_EXPIRED, { exportId, attempt: attemptCount });
    }
  }

  // As for jobs: a send no worker received is sent again, waiting longer each
  // time; an export is never failed because the queue is slow.
  private async redispatchUnreceived(): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string; dispatch_count: number }[]>`
        SELECT id, dispatch_count FROM job_exports
         WHERE status = 'queued' AND dispatch_count > 0 AND run_after <= now()
           AND dispatched_at < now() - make_interval(secs => least(
                 ${this.staleMs / 1000}::double precision * power(2, dispatch_count - 1),
                 ${EXPORT_MAX_REDISPATCH_WAIT_MS / 1000}::double precision))
         ORDER BY dispatched_at
         LIMIT ${EXPORT_MAINTENANCE_BATCH_SIZE}::int
           FOR UPDATE SKIP LOCKED`;
      for (const row of rows) {
        await tx.$executeRaw`
          UPDATE job_exports SET dispatched_at = now(), dispatch_count = dispatch_count + 1, updated_at = now()
           WHERE id = ${row.id}::uuid AND status = 'queued' AND dispatch_count > 0`;
        await this.outbox.enqueueExport(tx, { exportId: row.id, requestId: generateRequestId() });
        this.logger.warn(JobExportLogEvent.EXPORT_REDISPATCHED, {
          exportId: row.id,
          dispatchCount: row.dispatch_count + 1,
        });
      }
    });
  }

  // The row says expired before the file goes, so no download starts on a file
  // being deleted. A file that fails to delete is left behind, never served.
  private async deleteExpiredFiles(): Promise<void> {
    const expired = await this.prisma.$queryRaw<{ id: string }[]>`
      UPDATE job_exports SET status = 'expired', file_key = NULL, updated_at = now()
       WHERE id IN (SELECT id FROM job_exports
                     WHERE status = 'ready' AND expires_at < now()
                     ORDER BY expires_at
                     LIMIT ${EXPORT_MAINTENANCE_BATCH_SIZE}::int
                       FOR UPDATE SKIP LOCKED)
      RETURNING id`;
    for (const { id } of expired) {
      await this.files.delete(exportFileKey(id));
      this.logger.log(JobExportLogEvent.EXPORT_EXPIRED, { exportId: id });
    }
  }
}
