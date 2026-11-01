import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '#core/config/env.validation.ts';
import { type AiProvider, PermanentAiError, TransientAiError } from '#infra/ai-provider/ai-provider.ts';
import { AiProviderRegistry } from '#infra/ai-provider/ai-provider.registry.ts';
import { JobConfigService, type JobTypeLimits } from '#modules/job-config/job-config.service.ts';
import { type ContentForProcessing, JobContentsService } from '#modules/job-contents/job-contents.service.ts';
import type { ClaimableJob } from '#modules/jobs/job-lifecycle.service.ts';
import { JobResultSource } from '#generated/prisma/enums.ts';
import { describeError } from '#shared/describe-error.ts';
import { Semaphore } from '#shared/semaphore.ts';
import { sleep } from '#shared/sleep.ts';
import { untilAborted } from '#shared/until-aborted.ts';
import type { JobOutcome, Resolution } from './job-outcome.ts';
import { JobResultCacheService } from './job-result-cache.service.ts';
import {
  CALL_LOCK_MARGIN_MS,
  CALL_LOCK_POLL_MS,
  JobFailureCode,
  JobWorkerLogEvent,
  MAX_RESULT_CHARS,
} from './job-worker.constants.ts';

// Why processing stops early: the signal, and which of the worker's own reasons fired.
export type StopSignal = {
  signal: AbortSignal;
  reason(): 'shutdown' | 'lease_lost';
};

export type ResolveRequest = {
  job: ClaimableJob;
  content: ContentForProcessing;
  limits: JobTypeLimits;
  stop: StopSignal;
  // Claims the job; called right before its provider call. False when the
  // job finished meanwhile or another worker holds it.
  claim: () => Promise<boolean>;
};

const NOT_CLAIMED: Resolution = { kind: 'not_claimed' };

function interrupted(stop: StopSignal): JobOutcome {
  return { kind: 'interrupted', reason: stop.reason() };
}

function coalesced(text: string): JobOutcome {
  return { kind: 'completed', text, source: JobResultSource.coalesced };
}

// Resolves with the outcome of another job's call, or with an interruption
// once `stop` aborts. If that call fails (its job hit a database error), the
// waiting job gets no outcome and tries on its own; the error belongs to the
// other job, which handles it.
function untilStopped(promise: Promise<Resolution>, stop: StopSignal): Promise<Resolution> {
  if (stop.signal.aborted) {
    return Promise.resolve(interrupted(stop));
  }
  return new Promise((resolve) => {
    const onAbort = (): void => resolve(interrupted(stop));
    stop.signal.addEventListener('abort', onAbort, { once: true });
    const settle = (outcome: Resolution): void => {
      stop.signal.removeEventListener('abort', onAbort);
      resolve(outcome);
    };
    promise.then(settle, () => settle(NOT_CLAIMED));
  });
}

// Finds a job's result, calling the provider only when nothing else has it:
// 1. a result in the cache Redis, or a recent permanent rejection there;
// 2. the stored result (Redis lost or evicted it);
// 3. a provider call for the same content already running in this worker;
// 4. a provider call already running in another worker (the Redis call lock);
// 5. a provider call of its own, within this worker's concurrency limit.
// Redis only saves calls: when it is down, (1) and (4) are skipped and the
// database result and per-worker sharing still apply.
//
// Only (5) claims the job, once a permit and the call lock are held. A job
// waiting for either holds nothing in the database.
@Injectable()
export class JobResolverService {
  private readonly logger = new Logger(JobResolverService.name);
  private readonly permits: Semaphore;
  private readonly inFlightCalls = new Map<string, Promise<Resolution>>();

  constructor(
    private readonly providers: AiProviderRegistry,
    private readonly jobConfig: JobConfigService,
    private readonly contents: JobContentsService,
    private readonly resultCache: JobResultCacheService,
    config: ConfigService<Env, true>,
  ) {
    this.permits = new Semaphore(config.get('WORKER_PROVIDER_CONCURRENCY', { infer: true }));
  }

  async resolve(request: ResolveRequest): Promise<Resolution> {
    const known = await this.findKnownOutcome(request.content, request.limits);
    if (known) {
      return known;
    }
    // A leader whose call failed transiently, was interrupted, hit a database
    // error or whose job could not be claimed leaves the next waiting job to
    // try; a permanent
    // rejection or success is shared.
    for (;;) {
      const shared = this.inFlightCalls.get(request.content.id);
      if (!shared) {
        return this.lead(request);
      }
      const outcome = await untilStopped(shared, request.stop);
      if (outcome.kind === 'completed') {
        return { ...outcome, source: JobResultSource.coalesced };
      }
      if (outcome.kind === 'permanent' || request.stop.signal.aborted) {
        return request.stop.signal.aborted ? interrupted(request.stop) : outcome;
      }
    }
  }

  private async findKnownOutcome(content: ContentForProcessing, limits: JobTypeLimits): Promise<JobOutcome | null> {
    const cached = await this.resultCache.getResult(content.messageKey);
    if (cached !== null) {
      return { kind: 'completed', text: cached, source: JobResultSource.cache };
    }
    const failure = await this.resultCache.getFailure(content.messageKey);
    if (failure !== null) {
      return { kind: 'permanent', errorCode: failure };
    }
    const stored = await this.contents.findResult(content.id);
    if (stored === null) {
      return null;
    }
    await this.resultCache.setResult(content.messageKey, stored, limits.cacheTtlSeconds);
    return { kind: 'completed', text: stored, source: JobResultSource.cache };
  }

  private async lead(request: ResolveRequest): Promise<Resolution> {
    const call = this.callOrFollow(request);
    this.inFlightCalls.set(request.content.id, call);
    try {
      return await call;
    } finally {
      if (this.inFlightCalls.get(request.content.id) === call) {
        this.inFlightCalls.delete(request.content.id);
      }
    }
  }

  // Calls the provider, or waits while another worker calls it for the same
  // content; takes over if that worker's call ends without an answer.
  private async callOrFollow(request: ResolveRequest): Promise<Resolution> {
    for (;;) {
      const outcome = (await this.callOnce(request)) ?? (await this.followOtherWorker(request));
      if (outcome) {
        return outcome;
      }
    }
  }

  // Null when another worker holds the call lock.
  private async callOnce(request: ResolveRequest): Promise<Resolution | null> {
    const adapter = this.jobConfig.findAdapter(request.job.providerCode);
    const provider = adapter ? this.providers.find(adapter) : undefined;
    if (!provider) {
      return { kind: 'permanent', errorCode: JobFailureCode.PROVIDER_NOT_CONFIGURED };
    }
    let release: () => void;
    try {
      release = await this.permits.acquire(request.stop.signal);
    } catch {
      return interrupted(request.stop);
    }
    try {
      return await this.callUnderLock(request, provider);
    } finally {
      release();
    }
  }

  // The lock is taken once a permit is held, so a worker waiting for a free
  // slot does not stop the other workers from calling.
  private async callUnderLock(request: ResolveRequest, provider: AiProvider): Promise<Resolution | null> {
    const key = request.content.messageKey;
    const token = randomUUID();
    const lockMs = request.limits.timeoutMs + CALL_LOCK_MARGIN_MS;
    const locked = await this.resultCache.acquireCallLock(key, token, lockMs);
    if (locked === false) {
      return null;
    }
    try {
      // The previous holder may have stored the result just before releasing the lock.
      const cached = locked ? await this.resultCache.getResult(key) : null;
      if (cached !== null) {
        return coalesced(cached);
      }
      if (!(await request.claim())) {
        return NOT_CLAIMED;
      }
      if (locked) {
        // The claim may have waited on the database; the lock must outlive the call itself.
        await this.resultCache.extendCallLock(key, token, lockMs);
      }
      const outcome = await this.callProvider(request, provider);
      await this.remember(key, outcome, request.limits);
      return outcome;
    } finally {
      if (locked) {
        await this.resultCache.releaseCallLock(key, token);
      }
    }
  }

  // Null when the lock is free again without an answer: the caller tries itself.
  private async followOtherWorker({ content, stop }: ResolveRequest): Promise<Resolution | null> {
    for (;;) {
      try {
        await sleep(CALL_LOCK_POLL_MS, stop.signal);
      } catch {
        return interrupted(stop);
      }
      const cached = await this.resultCache.getResult(content.messageKey);
      if (cached !== null) {
        return coalesced(cached);
      }
      const failure = await this.resultCache.getFailure(content.messageKey);
      if (failure !== null) {
        return { kind: 'permanent', errorCode: failure };
      }
      if ((await this.resultCache.isCallLocked(content.messageKey)) !== true) {
        return null;
      }
    }
  }

  private async remember(key: string, outcome: JobOutcome, limits: JobTypeLimits): Promise<void> {
    if (outcome.kind === 'completed') {
      await this.resultCache.setResult(key, outcome.text, limits.cacheTtlSeconds);
    } else if (outcome.kind === 'permanent' && outcome.errorCode === JobFailureCode.PROVIDER_REJECTED) {
      await this.resultCache.setFailure(key, outcome.errorCode);
    }
  }

  private async callProvider(
    { job, content, limits, stop }: ResolveRequest,
    provider: AiProvider,
  ): Promise<JobOutcome> {
    // Starts once a permit is held: it limits the provider call, not the wait for a slot.
    const timeout = AbortSignal.timeout(limits.timeoutMs);
    const signal = AbortSignal.any([stop.signal, timeout]);
    try {
      // The timeout holds even for an adapter that ignores the signal.
      const result = await untilAborted(
        provider.generate(
          { jobType: content.jobTypeCode, input: content.input, modelVersion: job.modelVersion },
          signal,
        ),
        signal,
      );
      if (result.text.trim().length === 0 || result.text.length > MAX_RESULT_CHARS) {
        return { kind: 'transient', errorCode: JobFailureCode.PROVIDER_INVALID_RESPONSE };
      }
      return { kind: 'completed', text: result.text, source: JobResultSource.provider };
    } catch (error) {
      return this.classify(error instanceof Error ? error : new Error(String(error)), stop, timeout);
    }
  }

  // A timeout counts as a transient error (the case). Unknown errors are
  // treated as transient too: retrying is safe, and attempts are limited.
  private classify(error: Error, stop: StopSignal, timeout: AbortSignal): JobOutcome {
    if (stop.signal.aborted) {
      return interrupted(stop);
    }
    if (timeout.aborted) {
      return { kind: 'transient', errorCode: JobFailureCode.PROVIDER_TIMEOUT };
    }
    if (error instanceof PermanentAiError) {
      return { kind: 'permanent', errorCode: JobFailureCode.PROVIDER_REJECTED };
    }
    if (!(error instanceof TransientAiError)) {
      this.logger.error(JobWorkerLogEvent.PROVIDER_ERROR_UNEXPECTED, { reason: describeError(error) });
    }
    return { kind: 'transient', errorCode: JobFailureCode.PROVIDER_UNAVAILABLE };
  }
}
