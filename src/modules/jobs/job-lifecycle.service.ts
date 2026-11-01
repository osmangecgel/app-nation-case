import { Injectable } from '@nestjs/common';
import { PrismaService } from '#infra/database/prisma.service.ts';
import { Prisma } from '#generated/prisma/client.ts';
import type { JobResultSource } from '#generated/prisma/enums.ts';

type JobToProcess = {
  id: string;
  userId: string;
  jobContentId: string;
  providerCode: string;
  modelVersion: string;
  cost: number;
};

// A job that may be claimed now, as it is before the claim.
export type ClaimableJob = JobToProcess & { attemptCount: number };

export type ClaimedJob = JobToProcess & {
  // Including this claim.
  attemptCount: number;
};

// A job the worker no longer holds, when it ends or goes back to the queue.
export type SettledJob = {
  userId: string;
  cost: number;
};

export type StuckJob = {
  id: string;
  userId: string;
  jobContentId: string;
  cost: number;
  attemptCount: number;
  dispatchCount: number;
};

type JobRow = {
  id: string;
  user_id: string;
  job_content_id: string;
  job_provider_code: string;
  model_version: string;
  cost: number;
  attempt_count: number;
};

type StuckRow = {
  id: string;
  user_id: string;
  job_content_id: string;
  cost: number;
  attempt_count: number;
  dispatch_count: number;
};

// The database refuses more; a job that keeps losing its lease is failed by the
// reconciler well before this.
const ATTEMPT_COUNT_LIMIT = 10;

// A queued job whose backoff has passed, or a processing job whose lease
// expired (its worker died).
//
// run_after only delays retries. A new job's run_after is written with the
// API's clock and compared here with the database's; checking it for a job
// never tried would turn a few milliseconds of clock difference into a
// skipped message, and the job would wait for the reconciler.
const CLAIMABLE = Prisma.sql`
  attempt_count < ${ATTEMPT_COUNT_LIMIT}
  AND ((status = 'queued' AND (attempt_count = 0 OR run_after <= now()))
       OR (status = 'processing' AND locked_until < now()))`;

const JOB_COLUMNS = Prisma.sql`id, user_id, job_content_id, job_provider_code, model_version, cost, attempt_count`;

function toJob(row: JobRow): ClaimedJob {
  return {
    id: row.id,
    userId: row.user_id,
    jobContentId: row.job_content_id,
    providerCode: row.job_provider_code,
    modelVersion: row.model_version,
    cost: row.cost,
    attemptCount: row.attempt_count,
  };
}

function toStuckJob(row: StuckRow): StuckJob {
  return {
    id: row.id,
    userId: row.user_id,
    jobContentId: row.job_content_id,
    cost: row.cost,
    attemptCount: row.attempt_count,
    dispatchCount: row.dispatch_count,
  };
}

// State changes of a job after it was created, for the worker and the
// reconciler. Every change by a worker requires its lock_token (a fencing
// token): a worker whose lease expired, and whose job another worker took
// over, can no longer change the job.
@Injectable()
export class JobLifecycleService {
  constructor(private readonly prisma: PrismaService) {}

  // Null when the job finished, waits for its retry time or is held by a
  // worker. Does not claim: the worker claims the job once it can work on it.
  // It records that a worker received the job (dispatch_count = 0), so the
  // reconciler does not take a job waiting in a worker for a lost message;
  // if that worker dies, the broker delivers the message again.
  async findClaimable(jobId: string): Promise<ClaimableJob | null> {
    const [row] = await this.prisma.$queryRaw<JobRow[]>`
      WITH received AS (
        UPDATE jobs SET dispatch_count = 0
         WHERE id = ${jobId}::uuid AND status = 'queued' AND dispatch_count > 0 AND ${CLAIMABLE}
      )
      SELECT ${JOB_COLUMNS} FROM jobs WHERE id = ${jobId}::uuid AND ${CLAIMABLE}`;
    return row ? toJob(row) : null;
  }

  // A single conditional UPDATE: of two workers given the same job, one gets
  // the row and the other null. A worker took the job, so the count of
  // dispatches nobody picked up starts again.
  async claim(jobId: string, lockToken: string, leaseMs: number): Promise<ClaimedJob | null> {
    const [row] = await this.prisma.$queryRaw<JobRow[]>`
      UPDATE jobs
         SET status = 'processing',
             attempt_count = attempt_count + 1,
             lock_token = ${lockToken}::uuid,
             locked_until = now() + make_interval(secs => ${leaseMs / 1000}::double precision),
             dispatch_count = 0,
             updated_at = now()
       WHERE id = ${jobId}::uuid AND ${CLAIMABLE}
      RETURNING ${JOB_COLUMNS}`;
    return row ? toJob(row) : null;
  }

  // The worker's heartbeat. False when the lease is gone (taken over or finished).
  async extendLease(jobId: string, lockToken: string, leaseMs: number): Promise<boolean> {
    const count = await this.prisma.$executeRaw`
      UPDATE jobs
         SET locked_until = now() + make_interval(secs => ${leaseMs / 1000}::double precision), updated_at = now()
       WHERE id = ${jobId}::uuid AND lock_token = ${lockToken}::uuid AND status = 'processing'`;
    return count > 0;
  }

  // Null when the worker no longer holds the job: nothing was changed.
  async complete(
    tx: Prisma.TransactionClient,
    jobId: string,
    lockToken: string,
    resultSource: JobResultSource,
  ): Promise<SettledJob | null> {
    const [row] = await tx.$queryRaw<{ user_id: string; cost: number }[]>`
      UPDATE jobs
         SET status = 'completed', result_source = ${resultSource}::job_result_source, error_code = NULL,
             finished_at = now(), lock_token = NULL, locked_until = NULL, updated_at = now()
       WHERE id = ${jobId}::uuid AND lock_token = ${lockToken}::uuid AND status = 'processing'
      RETURNING user_id, cost`;
    return row ? { userId: row.user_id, cost: row.cost } : null;
  }

  async fail(
    tx: Prisma.TransactionClient,
    jobId: string,
    lockToken: string,
    errorCode: string,
  ): Promise<SettledJob | null> {
    const [row] = await tx.$queryRaw<{ user_id: string; cost: number }[]>`
      UPDATE jobs
         SET status = 'failed', error_code = ${errorCode}, finished_at = now(),
             lock_token = NULL, locked_until = NULL, updated_at = now()
       WHERE id = ${jobId}::uuid AND lock_token = ${lockToken}::uuid AND status = 'processing'
      RETURNING user_id, cost`;
    return row ? { userId: row.user_id, cost: row.cost } : null;
  }

  // Back to the queue for delayMs (retry backoff), measured on the database's
  // clock, which is the one run_after is compared with. Returns the time the
  // job may run again, null when the worker no longer holds it. The caller
  // enqueues the outbox message for that time in the same transaction.
  async scheduleRetry(
    tx: Prisma.TransactionClient,
    jobId: string,
    lockToken: string,
    delayMs: number,
  ): Promise<Date | null> {
    const [row] = await tx.$queryRaw<{ run_after: Date }[]>`
      UPDATE jobs
         SET status = 'queued', run_after = now() + make_interval(secs => ${delayMs / 1000}::double precision),
             lock_token = NULL, locked_until = NULL,
             dispatched_at = now(), dispatch_count = 1, updated_at = now()
       WHERE id = ${jobId}::uuid AND lock_token = ${lockToken}::uuid AND status = 'processing'
      RETURNING run_after`;
    return row?.run_after ?? null;
  }

  // Graceful shutdown stopped the job before the provider answered: it goes
  // back to the queue and the interrupted attempt does not count.
  async returnToQueue(tx: Prisma.TransactionClient, jobId: string, lockToken: string): Promise<boolean> {
    const count = await tx.$executeRaw`
      UPDATE jobs
         SET status = 'queued', attempt_count = greatest(attempt_count - 1, 0), run_after = now(),
             lock_token = NULL, locked_until = NULL,
             dispatched_at = now(), dispatch_count = 1, updated_at = now()
       WHERE id = ${jobId}::uuid AND lock_token = ${lockToken}::uuid AND status = 'processing'`;
    return count > 0;
  }

  // ---------------------------------------------------------------------------
  // Reconciler. Rows are locked with SKIP LOCKED, so reconcilers running in
  // several workers never handle the same job twice. Every change re-checks
  // the condition that selected the row.
  // ---------------------------------------------------------------------------

  // Processing jobs whose worker stopped sending heartbeats.
  async lockExpiredLeases(tx: Prisma.TransactionClient, limit: number): Promise<StuckJob[]> {
    const rows = await tx.$queryRaw<StuckRow[]>`
      SELECT id, user_id, job_content_id, cost, attempt_count, dispatch_count
        FROM jobs
       WHERE status = 'processing' AND locked_until < now()
       ORDER BY locked_until
       LIMIT ${limit}
         FOR UPDATE SKIP LOCKED`;
    return rows.map(toStuckJob);
  }

  // Queued jobs whose last message no worker has received: still waiting in
  // the broker behind a backlog, or lost. The wait before sending again
  // doubles with every send nobody received (staleMs, 2 × staleMs, ...), up
  // to maxWaitMs, so a backlog is not flooded with copies of its own jobs.
  async lockStaleQueued(
    tx: Prisma.TransactionClient,
    wait: { staleMs: number; maxWaitMs: number },
    limit: number,
  ): Promise<StuckJob[]> {
    const rows = await tx.$queryRaw<StuckRow[]>`
      SELECT id, user_id, job_content_id, cost, attempt_count, dispatch_count
        FROM jobs
       WHERE status = 'queued'
         AND dispatch_count > 0
         AND dispatched_at < now() - make_interval(secs => least(
               ${wait.staleMs / 1000}::double precision * power(2, dispatch_count - 1),
               ${wait.maxWaitMs / 1000}::double precision))
         AND run_after <= now()
       ORDER BY dispatched_at
       LIMIT ${limit}
         FOR UPDATE SKIP LOCKED`;
    return rows.map(toStuckJob);
  }

  async requeueExpired(tx: Prisma.TransactionClient, jobId: string): Promise<boolean> {
    const count = await tx.$executeRaw`
      UPDATE jobs
         SET status = 'queued', run_after = now(), lock_token = NULL, locked_until = NULL,
             dispatched_at = now(), dispatch_count = 1, updated_at = now()
       WHERE id = ${jobId}::uuid AND status = 'processing' AND locked_until < now()`;
    return count > 0;
  }

  async redispatch(tx: Prisma.TransactionClient, jobId: string): Promise<boolean> {
    const count = await tx.$executeRaw`
      UPDATE jobs
         SET dispatched_at = now(), dispatch_count = dispatch_count + 1, updated_at = now()
       WHERE id = ${jobId}::uuid AND status = 'queued' AND dispatch_count > 0`;
    return count > 0;
  }

  // A job whose worker died during its last allowed attempt. Null when it moved on meanwhile.
  async failStuck(tx: Prisma.TransactionClient, jobId: string, errorCode: string): Promise<SettledJob | null> {
    const [row] = await tx.$queryRaw<{ user_id: string; cost: number }[]>`
      UPDATE jobs
         SET status = 'failed', error_code = ${errorCode}, finished_at = now(),
             lock_token = NULL, locked_until = NULL, updated_at = now()
       WHERE id = ${jobId}::uuid AND status = 'processing' AND locked_until < now()
      RETURNING user_id, cost`;
    return row ? { userId: row.user_id, cost: row.cost } : null;
  }
}
