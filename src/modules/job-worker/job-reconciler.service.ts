import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '#core/config/env.validation.ts';
import { RequestContext } from '#core/context/request-context.ts';
import { generateRequestId } from '#core/context/request-id.ts';
import { PrismaService } from '#infra/database/prisma.service.ts';
import { JobConfigService } from '#modules/job-config/job-config.service.ts';
import { JobContentsService } from '#modules/job-contents/job-contents.service.ts';
import { JobOutboxService } from '#modules/job-outbox/job-outbox.service.ts';
import { JobLifecycleService, type StuckJob } from '#modules/jobs/job-lifecycle.service.ts';
import { UsersService } from '#modules/users/users.service.ts';
import type { Prisma } from '#generated/prisma/client.ts';
import { describeError } from '#shared/describe-error.ts';
import {
  JobFailureCode,
  JobWorkerLogEvent,
  MAX_REDISPATCH_WAIT_MS,
  RECONCILER_BATCH_SIZE,
} from './job-worker.constants.ts';

// The safety net. Kafka is how jobs reach workers, but the database decides
// what a job's state is; this loop guarantees every accepted job ends up
// completed or failed (with its credits released), whatever happens to a
// message or a worker:
// - a processing job whose worker stopped heartbeating goes back to the queue,
//   or fails if that was its last allowed attempt;
// - a queued job whose message no worker received is sent again, waiting
//   longer each time (a backlog is slow, not lost, so it is never failed for
//   it). A job a worker received is left alone however long it waits there:
//   if that worker dies, the broker delivers its message again.
// Every worker runs it; SKIP LOCKED keeps two of them off the same job.
@Injectable()
export class JobReconcilerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(JobReconcilerService.name);
  private readonly intervalMs: number;
  private readonly staleQueuedMs: number;
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private stopped = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly lifecycle: JobLifecycleService,
    private readonly contents: JobContentsService,
    private readonly outbox: JobOutboxService,
    private readonly users: UsersService,
    private readonly jobConfig: JobConfigService,
    private readonly context: RequestContext,
    config: ConfigService<Env, true>,
  ) {
    this.intervalMs = config.get('RECONCILER_INTERVAL_MS', { infer: true });
    this.staleQueuedMs = config.get('RECONCILER_STALE_QUEUED_MS', { infer: true });
  }

  // The next run is scheduled when this one ends, so a slow run never overlaps the next.
  onApplicationBootstrap(): void {
    this.schedule();
  }

  // Waits for a run in progress, so the database connection, closed after
  // this, is not closed under it.
  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }

  async reconcile(): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      for (const job of await this.lifecycle.lockExpiredLeases(tx, RECONCILER_BATCH_SIZE)) {
        await this.inJobContext(tx, job, () => this.recoverExpired(tx, job));
      }
    });
    await this.prisma.$transaction(async (tx) => {
      const wait = { staleMs: this.staleQueuedMs, maxWaitMs: MAX_REDISPATCH_WAIT_MS };
      for (const job of await this.lifecycle.lockStaleQueued(tx, wait, RECONCILER_BATCH_SIZE)) {
        await this.inJobContext(tx, job, () => this.redispatchStale(tx, job));
      }
    });
  }

  // Log lines and the new message keep the id of the request that created the
  // job, so one search still finds the job's whole way.
  private async inJobContext(tx: Prisma.TransactionClient, job: StuckJob, work: () => Promise<void>): Promise<void> {
    const requestId = (await this.outbox.findRequestId(tx, job.id)) ?? generateRequestId();
    await this.context.run({ requestId, jobId: job.id }, work);
  }

  private schedule(): void {
    if (!this.stopped) {
      // Each run logs under its own request id; a job it touches logs under the
      // id of the request that created that job (inJobContext).
      this.timer = setTimeout(() => {
        this.running = this.context.run({ requestId: generateRequestId() }, () => this.runOnce());
      }, this.intervalMs);
    }
  }

  private async runOnce(): Promise<void> {
    try {
      await this.reconcile();
    } catch (error) {
      this.logger.error(JobWorkerLogEvent.RECONCILER_FAILED, { reason: describeError(error) });
    } finally {
      this.schedule();
    }
  }

  private async recoverExpired(tx: Prisma.TransactionClient, job: StuckJob): Promise<void> {
    const content = await this.contents.findForProcessing(job.jobContentId, tx);
    const limits = this.jobConfig.findLimits(content.jobTypeCode);
    if (!limits || job.attemptCount >= limits.maxAttemptCount) {
      await this.failAndRelease(tx, job, JobFailureCode.WORKER_LOST);
      return;
    }
    if (await this.lifecycle.requeueExpired(tx, job.id)) {
      const requestId = this.context.requestId() ?? generateRequestId();
      await this.outbox.enqueue(tx, { jobId: job.id, messageKey: content.messageKey, requestId });
      this.logger.warn(JobWorkerLogEvent.JOB_LEASE_EXPIRED, { attempt: job.attemptCount });
    }
  }

  private async redispatchStale(tx: Prisma.TransactionClient, job: StuckJob): Promise<void> {
    if (await this.lifecycle.redispatch(tx, job.id)) {
      const content = await this.contents.findForProcessing(job.jobContentId, tx);
      const requestId = this.context.requestId() ?? generateRequestId();
      await this.outbox.enqueue(tx, { jobId: job.id, messageKey: content.messageKey, requestId });
      this.logger.warn(JobWorkerLogEvent.JOB_REDISPATCHED, { dispatchCount: job.dispatchCount + 1 });
    }
  }

  private async failAndRelease(tx: Prisma.TransactionClient, job: StuckJob, errorCode: string): Promise<void> {
    const settled = await this.lifecycle.failStuck(tx, job.id, errorCode);
    if (settled) {
      await this.users.releaseCredits(tx, { userId: settled.userId, jobId: job.id, cost: settled.cost });
      this.logger.warn(JobWorkerLogEvent.JOB_FAILED, { errorCode, attempt: job.attemptCount });
    }
  }
}
