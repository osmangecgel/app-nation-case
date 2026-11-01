import { randomInt, randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '#core/config/env.validation.ts';
import { TooManyRequestsError } from '#core/errors/app-errors.ts';
import { CacheService } from '#infra/cache/cache.service.ts';
import { Semaphore } from '#shared/semaphore.ts';
import { sleep } from '#shared/sleep.ts';
import {
  EXPORT_RETRY_AFTER_SECONDS,
  EXPORT_SLOT_LEASE_MS,
  EXPORT_SLOT_POLL_MAX_MS,
  EXPORT_SLOT_POLL_MIN_MS,
  JobExportErrorCode,
  JobExportLogEvent,
} from './job-exports.constants.ts';

const USER_LOCK_DOMAIN = 'export_user';
const SLOTS_DOMAIN = 'export_slots';
const SLOTS_ID = 'all';
// Renewed three times per lease, so one missed renewal never loses it.
const RENEW_EVERY_MS = EXPORT_SLOT_LEASE_MS / 3;

// Held while a streamed export runs; release() must be called when it ends.
export type ExportPass = { release(): Promise<void> };

// Admission control for streamed exports, so that however many users export
// at once, the database serves at most EXPORT_MAX_CONCURRENT of them and the
// rest of the API keeps its connections:
// - one streamed export per user at a time (a second gets 429 at once);
// - at most EXPORT_MAX_CONCURRENT across every instance: a leased permit in
//   Redis, renewed while the export runs, so a crashed instance's permits free
//   themselves;
// - a request waits up to EXPORT_ADMISSION_WAIT_MS for a permit, then gets 429
//   with Retry-After; a client that leaves stops waiting at once.
// Without Redis the limit falls back to EXPORT_FALLBACK_MAX_CONCURRENT per
// instance: the database is protected in an outage too.
//
// Waiting requests ask again after a random 100–500 ms, so a free permit goes
// to whichever asks first, not to the longest waiting; the wait is short and
// bounded, so this is accepted.
@Injectable()
export class ExportAdmissionService {
  private readonly logger = new Logger(ExportAdmissionService.name);
  private readonly maxConcurrent: number;
  private readonly waitMs: number;
  private readonly fallback: Semaphore;

  constructor(
    private readonly cache: CacheService,
    config: ConfigService<Env, true>,
  ) {
    this.maxConcurrent = config.get('EXPORT_MAX_CONCURRENT', { infer: true });
    this.waitMs = config.get('EXPORT_ADMISSION_WAIT_MS', { infer: true });
    this.fallback = new Semaphore(config.get('EXPORT_FALLBACK_MAX_CONCURRENT', { infer: true }));
  }

  // Throws TooManyRequestsError when refused, or the signal's reason when the
  // client left while waiting.
  async admit(userId: string, signal: AbortSignal): Promise<ExportPass> {
    const holder = randomUUID();
    const locked = await this.cache.acquireLock(USER_LOCK_DOMAIN, userId, holder, EXPORT_SLOT_LEASE_MS);
    if (locked === false) {
      throw new TooManyRequestsError(
        JobExportErrorCode.EXPORT_IN_PROGRESS,
        'An export of yours is already running. Try again when it has finished.',
        EXPORT_RETRY_AFTER_SECONDS,
      );
    }
    const releaseLock = (): Promise<void> =>
      locked ? this.cache.releaseLock(USER_LOCK_DOMAIN, userId, holder) : Promise.resolve();
    try {
      const releaseSlot = await this.takeSlot(holder, signal);
      return this.pass(userId, holder, releaseSlot, releaseLock);
    } catch (error) {
      await releaseLock();
      throw error;
    }
  }

  // Returns the slot's release. Uses the shared permits while Redis answers,
  // the per-instance fallback otherwise.
  private async takeSlot(holder: string, signal: AbortSignal): Promise<() => Promise<void>> {
    const deadline = Date.now() + this.waitMs;
    for (;;) {
      const taken = await this.cache.acquirePermit(
        SLOTS_DOMAIN,
        SLOTS_ID,
        holder,
        this.maxConcurrent,
        EXPORT_SLOT_LEASE_MS,
      );
      if (taken === true) {
        return () => this.cache.releasePermit(SLOTS_DOMAIN, SLOTS_ID, holder);
      }
      if (taken === null) {
        return this.takeFallbackSlot(deadline, signal);
      }
      const left = deadline - Date.now();
      if (left <= 0) {
        throw busy();
      }
      await sleep(Math.min(left, randomInt(EXPORT_SLOT_POLL_MIN_MS, EXPORT_SLOT_POLL_MAX_MS + 1)), signal);
    }
  }

  private async takeFallbackSlot(deadline: number, signal: AbortSignal): Promise<() => Promise<void>> {
    this.logger.warn(JobExportLogEvent.EXPORT_SLOT_FALLBACK);
    const timeout = AbortSignal.timeout(Math.max(deadline - Date.now(), 0));
    try {
      const release = await this.fallback.acquire(AbortSignal.any([signal, timeout]));
      return () => {
        release();
        return Promise.resolve();
      };
    } catch (error) {
      throw signal.aborted ? error : busy();
    }
  }

  private pass(
    userId: string,
    holder: string,
    releaseSlot: () => Promise<void>,
    releaseLock: () => Promise<void>,
  ): ExportPass {
    // A failed renewal is not acted on: the export goes on, and at worst its
    // lease lapses and one more export than the limit may start.
    const renewal = setInterval(() => {
      void this.cache.renewPermit(SLOTS_DOMAIN, SLOTS_ID, holder, EXPORT_SLOT_LEASE_MS);
      void this.cache.extendLock(USER_LOCK_DOMAIN, userId, holder, EXPORT_SLOT_LEASE_MS);
    }, RENEW_EVERY_MS);
    let released = false;
    return {
      release: async () => {
        if (released) {
          return;
        }
        released = true;
        clearInterval(renewal);
        await Promise.all([releaseSlot(), releaseLock()]);
      },
    };
  }
}

function busy(): TooManyRequestsError {
  return new TooManyRequestsError(
    JobExportErrorCode.EXPORT_SLOTS_BUSY,
    'Too many exports are running right now. Try again shortly.',
    EXPORT_RETRY_AFTER_SECONDS,
  );
}
