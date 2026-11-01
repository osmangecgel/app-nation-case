import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { RequestContext } from '#core/context/request-context.ts';
import { generateRequestId } from '#core/context/request-id.ts';
import { PrismaService } from '#infra/database/prisma.service.ts';
import { describeError } from '#shared/describe-error.ts';
import {
  JobIdempotencyLogEvent,
  KEY_CLEANUP_BATCH_SIZE,
  KEY_CLEANUP_INTERVAL_MS,
} from './job-idempotency.constants.ts';

// Deletes keys past their 24 hours. Correctness does not depend on it: a claim
// that meets an expired key removes it itself. Without it the table would only
// grow, by one row per job ever created.
//
// Every worker runs it; SKIP LOCKED keeps two of them off the same rows, and a
// key a request is claiming right now is left alone.
@Injectable()
export class JobIdempotencyCleanupService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(JobIdempotencyCleanupService.name);
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly context: RequestContext,
  ) {}

  onApplicationBootstrap(): void {
    // Each run logs under its own request id.
    this.timer = setInterval(() => {
      this.running = this.context.run({ requestId: generateRequestId() }, () => this.runOnce());
    }, KEY_CLEANUP_INTERVAL_MS);
  }

  // Waits for a run in progress, so the database connection, closed after
  // this, is not closed under it.
  async onApplicationShutdown(): Promise<void> {
    clearInterval(this.timer);
    await this.running;
  }

  // Returns the number of keys deleted.
  async deleteExpired(): Promise<number> {
    let deleted = 0;
    for (;;) {
      const count = await this.prisma.$executeRaw`
        DELETE FROM job_idempotency_keys
         WHERE (user_id, idempotency_key) IN (
           SELECT user_id, idempotency_key FROM job_idempotency_keys
            WHERE expires_at <= now()
            ORDER BY expires_at
            LIMIT ${KEY_CLEANUP_BATCH_SIZE}
              FOR UPDATE SKIP LOCKED)`;
      deleted += count;
      if (count < KEY_CLEANUP_BATCH_SIZE) {
        return deleted;
      }
    }
  }

  private async runOnce(): Promise<void> {
    try {
      const deleted = await this.deleteExpired();
      if (deleted > 0) {
        this.logger.log(JobIdempotencyLogEvent.IDEMPOTENCY_KEYS_CLEANED_UP, { deleted });
      }
    } catch (error) {
      this.logger.warn(JobIdempotencyLogEvent.IDEMPOTENCY_KEY_CLEANUP_FAILED, { reason: describeError(error) });
    }
  }
}
