import { randomUUID } from 'node:crypto';
import type { Logger } from '@nestjs/common';
import type { ClaimableJob, ClaimedJob, JobLifecycleService } from '#modules/jobs/job-lifecycle.service.ts';
import { describeError } from '#shared/describe-error.ts';
import type { StopSignal } from './job-resolver.service.ts';
import { JobWorkerLogEvent } from './job-worker.constants.ts';

export type LeaseTiming = { leaseMs: number; heartbeatMs: number };

// The worker's two shutdown steps: `draining` stops jobs that are not claimed
// yet, `shutdown` (after the grace period) interrupts claimed ones.
export type WorkerSignals = { draining: AbortSignal; shutdown: AbortSignal };

// One job's way through the worker. The job is claimed only when the worker is
// about to work on it: right before its provider call, or once its outcome is
// known without one. Until then it holds no lease and writes nothing, so a job
// waiting for a provider permit costs no database work, and a job given up
// while waiting is simply delivered again.
export class JobRun {
  readonly lockToken = randomUUID();
  readonly stop: StopSignal;
  private claimedJob: ClaimedJob | null = null;
  private readonly lost = new AbortController();
  private readonly drained = new AbortController();
  private heartbeat?: ReturnType<typeof setInterval>;
  private readonly onDraining = (): void => {
    if (!this.claimedJob) {
      this.drained.abort(new Error('Worker is draining.'));
    }
  };

  constructor(
    readonly job: ClaimableJob,
    private readonly lifecycle: JobLifecycleService,
    private readonly timing: LeaseTiming,
    private readonly signals: WorkerSignals,
    private readonly logger: Logger,
  ) {
    if (signals.draining.aborted) {
      this.onDraining();
    } else {
      signals.draining.addEventListener('abort', this.onDraining, { once: true });
    }
    this.stop = {
      signal: AbortSignal.any([this.drained.signal, this.lost.signal, signals.shutdown]),
      reason: () => (this.lost.signal.aborted ? 'lease_lost' : 'shutdown'),
    };
  }

  get claimed(): ClaimedJob | null {
    return this.claimedJob;
  }

  // Null when the job finished meanwhile or another worker holds it.
  async claim(): Promise<ClaimedJob | null> {
    if (this.claimedJob) {
      return this.claimedJob;
    }
    const job = await this.lifecycle.claim(this.job.id, this.lockToken, this.timing.leaseMs);
    if (!job) {
      this.logger.debug(JobWorkerLogEvent.JOB_CLAIM_SKIPPED);
      return null;
    }
    this.claimedJob = job;
    this.holdLease(job);
    this.logger.log(JobWorkerLogEvent.JOB_CLAIMED, { attempt: job.attemptCount });
    return job;
  }

  release(): void {
    clearInterval(this.heartbeat);
    this.signals.draining.removeEventListener('abort', this.onDraining);
  }

  // Extends the lease every heartbeat. If the lease is gone (the job was taken
  // over), the work stops: its outcome could no longer be written anyway.
  private holdLease(job: ClaimedJob): void {
    this.heartbeat = setInterval(() => {
      this.lifecycle.extendLease(job.id, this.lockToken, this.timing.leaseMs).then(
        (held) => {
          if (!held) {
            this.lost.abort(new Error('Lease lost.'));
          }
        },
        // A database error is not proof the lease is gone; the next beat tries again.
        (error: Error) => this.logger.warn(JobWorkerLogEvent.JOB_LEASE_EXTEND_FAILED, { reason: describeError(error) }),
      );
    }, this.timing.heartbeatMs);
  }
}
