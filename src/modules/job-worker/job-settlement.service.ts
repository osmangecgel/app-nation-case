import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '#infra/database/prisma.service.ts';
import type { JobTypeLimits } from '#modules/job-config/job-config.service.ts';
import { type ContentForProcessing, JobContentsService } from '#modules/job-contents/job-contents.service.ts';
import { JobOutboxService } from '#modules/job-outbox/job-outbox.service.ts';
import { type ClaimedJob, JobLifecycleService } from '#modules/jobs/job-lifecycle.service.ts';
import { UsersService } from '#modules/users/users.service.ts';
import type { Prisma } from '#generated/prisma/client.ts';
import { JobResultSource } from '#generated/prisma/enums.ts';
import { describeError } from '#shared/describe-error.ts';
import { sleep } from '#shared/sleep.ts';
import { type JobOutcome, retryDelayMs } from './job-outcome.ts';
import {
  JobWorkerLogEvent,
  RETRY_BASE_DELAY_MS,
  RETRY_JITTER_MS,
  SETTLE_ATTEMPTS,
  SETTLE_RETRY_DELAY_MS,
} from './job-worker.constants.ts';

export type Settlement = {
  job: ClaimedJob;
  lockToken: string;
  content: ContentForProcessing;
  // Undefined when the job's type is gone from the configuration: no retries.
  limits: JobTypeLimits | undefined;
  requestId: string;
  outcome: JobOutcome;
};

type LogEntry = { event: string; fields: Record<string, string | number> };

// Writes the outcome of an attempt. Each outcome is one transaction: the job's
// state and its credit settlement commit together, and every change requires
// the worker's lock token, so a worker that lost its job changes nothing.
@Injectable()
export class JobSettlementService {
  private readonly logger = new Logger(JobSettlementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly lifecycle: JobLifecycleService,
    private readonly contents: JobContentsService,
    private readonly outbox: JobOutboxService,
    private readonly users: UsersService,
  ) {}

  // Retried briefly on a database error. If it still fails, the job keeps its
  // lease until it expires and the reconciler puts it back in the queue; the
  // provider may then be called again for it.
  async settle(settlement: Settlement): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        const entry = await this.prisma.$transaction((tx) => this.apply(tx, settlement));
        this.logger.log(entry.event, entry.fields);
        return;
      } catch (error) {
        if (attempt >= SETTLE_ATTEMPTS) {
          throw error;
        }
        this.logger.warn(JobWorkerLogEvent.JOB_SETTLE_FAILED, { attempt, reason: describeError(error) });
        await sleep(SETTLE_RETRY_DELAY_MS * attempt);
      }
    }
  }

  private apply(tx: Prisma.TransactionClient, settlement: Settlement): Promise<LogEntry> {
    const { outcome } = settlement;
    switch (outcome.kind) {
      case 'completed':
        return this.complete(tx, settlement, outcome.text, outcome.source);
      case 'permanent':
        return this.fail(tx, settlement, outcome.errorCode);
      case 'transient':
        return this.retryOrFail(tx, settlement, outcome.errorCode);
      case 'interrupted':
        return outcome.reason === 'shutdown'
          ? this.returnToQueue(tx, settlement)
          : Promise.resolve({ event: JobWorkerLogEvent.JOB_LEASE_LOST, fields: {} });
    }
  }

  private async complete(
    tx: Prisma.TransactionClient,
    { job, lockToken, content }: Settlement,
    text: string,
    source: JobResultSource,
  ): Promise<LogEntry> {
    const settled = await this.lifecycle.complete(tx, job.id, lockToken, source);
    if (!settled) {
      return { event: JobWorkerLogEvent.JOB_LEASE_LOST, fields: {} };
    }
    // Whatever the source: a result found only in the cache Redis came from a
    // worker that died before its settlement committed. Writing it is safe,
    // because only the first result is kept.
    await this.contents.saveResult(tx, content.id, text);
    await this.users.captureCredits(tx, { userId: settled.userId, jobId: job.id, cost: settled.cost });
    return { event: JobWorkerLogEvent.JOB_COMPLETED, fields: { source, attempt: job.attemptCount } };
  }

  private async fail(
    tx: Prisma.TransactionClient,
    { job, lockToken }: Settlement,
    errorCode: string,
  ): Promise<LogEntry> {
    const settled = await this.lifecycle.fail(tx, job.id, lockToken, errorCode);
    if (!settled) {
      return { event: JobWorkerLogEvent.JOB_LEASE_LOST, fields: {} };
    }
    await this.users.releaseCredits(tx, { userId: settled.userId, jobId: job.id, cost: settled.cost });
    return { event: JobWorkerLogEvent.JOB_FAILED, fields: { errorCode: errorCode, attempt: job.attemptCount } };
  }

  private async retryOrFail(
    tx: Prisma.TransactionClient,
    settlement: Settlement,
    errorCode: string,
  ): Promise<LogEntry> {
    const { job, lockToken, content, limits, requestId } = settlement;
    if (!limits || job.attemptCount >= limits.maxAttemptCount) {
      return this.fail(tx, settlement, errorCode);
    }
    const delayMs = retryDelayMs(job.attemptCount, RETRY_BASE_DELAY_MS, RETRY_JITTER_MS);
    const runAfter = await this.lifecycle.scheduleRetry(tx, job.id, lockToken, delayMs);
    if (!runAfter) {
      return { event: JobWorkerLogEvent.JOB_LEASE_LOST, fields: {} };
    }
    await this.outbox.enqueue(tx, { jobId: job.id, messageKey: content.messageKey, requestId, notBefore: runAfter });
    return {
      event: JobWorkerLogEvent.JOB_RETRY_SCHEDULED,
      fields: { attempt: job.attemptCount, errorCode: errorCode, delayMs: delayMs },
    };
  }

  private async returnToQueue(
    tx: Prisma.TransactionClient,
    { job, lockToken, content, requestId }: Settlement,
  ): Promise<LogEntry> {
    if (!(await this.lifecycle.returnToQueue(tx, job.id, lockToken))) {
      return { event: JobWorkerLogEvent.JOB_LEASE_LOST, fields: {} };
    }
    await this.outbox.enqueue(tx, { jobId: job.id, messageKey: content.messageKey, requestId });
    return { event: JobWorkerLogEvent.JOB_RETURNED_TO_QUEUE, fields: {} };
  }
}
