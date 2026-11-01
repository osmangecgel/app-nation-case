import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '#core/config/env.validation.ts';
import { RequestContext } from '#core/context/request-context.ts';
import { JobConfigService, type JobTypeLimits } from '#modules/job-config/job-config.service.ts';
import { type ContentForProcessing, JobContentsService } from '#modules/job-contents/job-contents.service.ts';
import { JobLifecycleService } from '#modules/jobs/job-lifecycle.service.ts';
import type { Resolution } from './job-outcome.ts';
import { JobResolverService } from './job-resolver.service.ts';
import { JobRun, type LeaseTiming } from './job-run.ts';
import { JobSettlementService } from './job-settlement.service.ts';
import { JobFailureCode, JobWorkerLogEvent } from './job-worker.constants.ts';

type Finish = {
  content: ContentForProcessing;
  limits: JobTypeLimits | undefined;
  requestId: string;
  resolution: Resolution;
};

// Processes one job end to end: resolve its result, claim it, settle the
// outcome (see JobRun for when the claim happens). Safe to call twice for the
// same job (a duplicate Kafka message, two workers): only one claim succeeds.
@Injectable()
export class JobProcessorService {
  private readonly logger = new Logger(JobProcessorService.name);
  private readonly draining = new AbortController();
  private readonly shutdown = new AbortController();
  private readonly timing: LeaseTiming;

  constructor(
    private readonly lifecycle: JobLifecycleService,
    private readonly contents: JobContentsService,
    private readonly jobConfig: JobConfigService,
    private readonly resolver: JobResolverService,
    private readonly settlement: JobSettlementService,
    private readonly context: RequestContext,
    config: ConfigService<Env, true>,
  ) {
    this.timing = {
      leaseMs: config.get('WORKER_LEASE_MS', { infer: true }),
      heartbeatMs: config.get('WORKER_HEARTBEAT_MS', { infer: true }),
    };
  }

  // False when the job was given up before it was claimed (the worker is
  // stopping): nothing was written, and its message must be delivered again.
  // Every log line written while the job runs carries its id and the request id
  // of the request that created it.
  process(jobId: string, requestId: string): Promise<boolean> {
    return this.context.run({ requestId, jobId }, () => this.run(jobId, requestId));
  }

  // Graceful shutdown, first step: jobs not claimed yet stop waiting.
  stopTakingJobs(): void {
    this.draining.abort(new Error('Worker is draining.'));
  }

  // Graceful shutdown, after the grace period: claimed jobs stop and go back to the queue.
  interruptInFlight(): void {
    this.shutdown.abort(new Error('Worker is shutting down.'));
  }

  private async run(jobId: string, requestId: string): Promise<boolean> {
    const job = await this.lifecycle.findClaimable(jobId);
    if (!job) {
      // Finished, held by another worker, waiting for its retry time, or a duplicate message.
      this.logger.debug(JobWorkerLogEvent.JOB_CLAIM_SKIPPED);
      return true;
    }
    const content = await this.contents.findForProcessing(job.jobContentId);
    const limits = this.jobConfig.findLimits(content.jobTypeCode);
    const signals = { draining: this.draining.signal, shutdown: this.shutdown.signal };
    const run = new JobRun(job, this.lifecycle, this.timing, signals, this.logger);
    try {
      const resolution = await this.resolve(run, content, limits);
      return await this.finish(run, { content, limits, requestId, resolution });
    } finally {
      run.release();
    }
  }

  private resolve(run: JobRun, content: ContentForProcessing, limits: JobTypeLimits | undefined): Promise<Resolution> {
    if (!limits) {
      return Promise.resolve({ kind: 'permanent', errorCode: JobFailureCode.JOB_TYPE_UNAVAILABLE });
    }
    // Taken over after its previous worker died during the last allowed attempt.
    if (run.job.attemptCount >= limits.maxAttemptCount) {
      return Promise.resolve({ kind: 'permanent', errorCode: JobFailureCode.WORKER_LOST });
    }
    return this.resolver.resolve({
      job: run.job,
      content,
      limits,
      stop: run.stop,
      claim: async () => (await run.claim()) !== null,
    });
  }

  private async finish(run: JobRun, { resolution, ...rest }: Finish): Promise<boolean> {
    if (resolution.kind === 'not_claimed') {
      return true;
    }
    if (!run.claimed && resolution.kind === 'interrupted') {
      return false;
    }
    const job = await run.claim();
    if (job) {
      await this.settlement.settle({ job, lockToken: run.lockToken, outcome: resolution, ...rest });
    }
    return true;
  }
}
