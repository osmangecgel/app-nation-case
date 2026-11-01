import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '#core/config/env.validation.ts';
import { RequestContext } from '#core/context/request-context.ts';
import { generateRequestId } from '#core/context/request-id.ts';
import { PrismaService } from '#infra/database/prisma.service.ts';
import { QueuePublisher } from '#infra/queue/queue.ts';
import { describeError } from '#shared/describe-error.ts';
import { type DispatchSubject, toDispatchMessage } from './messages/job-dispatch.message.ts';
import {
  OUTBOX_CLEANUP_BATCH_SIZE,
  OUTBOX_CLEANUP_INTERVAL_MS,
  OUTBOX_RELAY_BATCH_SIZE,
  OUTBOX_RELAY_TIMEOUT_MS,
  OUTBOX_RETENTION_MS,
  OutboxLogEvent,
} from './job-outbox.constants.ts';

type PendingMessage = {
  id: string;
  // Exactly one is set (job_outbox_messages_one_subject).
  job_id: string | null;
  export_id: string | null;
  topic: string;
  message_key: string;
  request_id: string;
};

function subjectOf(row: PendingMessage): DispatchSubject {
  if (row.job_id) {
    return { jobId: row.job_id };
  }
  if (row.export_id) {
    return { exportId: row.export_id };
  }
  // The database forbids it (job_outbox_messages_one_subject).
  throw new Error(`Outbox message ${row.id} names neither a job nor an export.`);
}

// Publishes outbox rows to the queue after the transactions that wrote them commit.
// Rows are locked with SKIP LOCKED, so several relays (one per worker) share
// the work without sending a row twice. A row is marked sent only after the broker
// acknowledged it; a crash in between sends it again, which consumers tolerate.
// Runs in the worker only: the API never waits on the broker.
@Injectable()
export class JobOutboxRelayService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(JobOutboxRelayService.name);
  private readonly intervalMs: number;
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private stopped = false;
  private lastCleanupAt = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly publisher: QueuePublisher,
    private readonly context: RequestContext,
    config: ConfigService<Env, true>,
  ) {
    this.intervalMs = config.get('OUTBOX_RELAY_INTERVAL_MS', { infer: true });
  }

  onApplicationBootstrap(): void {
    this.schedule();
  }

  // Waits for a round in progress, so the database and broker connections,
  // closed after this, are not closed under it.
  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }

  // Publishes due rows until fewer than a full batch are left. Returns the count sent.
  async relayPending(): Promise<number> {
    let sent = 0;
    for (;;) {
      const count = await this.relayBatch();
      sent += count;
      if (count < OUTBOX_RELAY_BATCH_SIZE) {
        return sent;
      }
    }
  }

  // The transaction holds the rows' locks while the broker acknowledges, bounded by
  // the producer's send timeout: no other relay can send them meanwhile.
  private relayBatch(): Promise<number> {
    return this.prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<PendingMessage[]>`
          SELECT id, job_id, export_id, topic, message_key, request_id
            FROM job_outbox_messages
           WHERE sent_at IS NULL AND not_before <= now()
           ORDER BY not_before
           LIMIT ${OUTBOX_RELAY_BATCH_SIZE}
             FOR UPDATE SKIP LOCKED`;
        if (rows.length === 0) {
          return 0;
        }
        await this.publisher.publish(
          rows.map((row) =>
            toDispatchMessage({
              ...subjectOf(row),
              topic: row.topic,
              messageKey: row.message_key,
              requestId: row.request_id,
            }),
          ),
        );
        await tx.$executeRaw`
          UPDATE job_outbox_messages SET sent_at = now() WHERE id = ANY(${rows.map((row) => row.id)}::uuid[])`;
        return rows.length;
      },
      { timeout: OUTBOX_RELAY_TIMEOUT_MS },
    );
  }

  private schedule(): void {
    if (!this.stopped) {
      // Each round logs under its own request id, so one search finds all its lines.
      this.timer = setTimeout(() => {
        this.running = this.context.run({ requestId: generateRequestId() }, () => this.tick());
      }, this.intervalMs);
    }
  }

  private async tick(): Promise<void> {
    try {
      await this.relayPending();
      await this.cleanUpIfDue();
    } catch (error) {
      // The broker or the database is unavailable: rows stay unsent and are retried next tick.
      this.logger.warn(OutboxLogEvent.OUTBOX_RELAY_FAILED, { reason: describeError(error) });
    } finally {
      this.schedule();
    }
  }

  // Sent rows are only needed briefly (to look into a recent incident). Every
  // worker runs this; SKIP LOCKED keeps two of them off the same rows, and
  // small batches keep each delete short. Returns the number of rows deleted.
  async deleteSent(): Promise<number> {
    let deleted = 0;
    for (;;) {
      const count = await this.prisma.$executeRaw`
        DELETE FROM job_outbox_messages
         WHERE id IN (
           SELECT id FROM job_outbox_messages
            WHERE sent_at < now() - make_interval(secs => ${OUTBOX_RETENTION_MS / 1000}::double precision)
            ORDER BY sent_at
            LIMIT ${OUTBOX_CLEANUP_BATCH_SIZE}
              FOR UPDATE SKIP LOCKED)`;
      deleted += count;
      if (count < OUTBOX_CLEANUP_BATCH_SIZE) {
        return deleted;
      }
    }
  }

  // Runs until every expired row is gone, so cleanup keeps up with any send rate.
  private async cleanUpIfDue(): Promise<void> {
    if (Date.now() - this.lastCleanupAt < OUTBOX_CLEANUP_INTERVAL_MS) {
      return;
    }
    this.lastCleanupAt = Date.now();
    const deleted = await this.deleteSent();
    if (deleted > 0) {
      this.logger.log(OutboxLogEvent.OUTBOX_CLEANED_UP, { deleted });
    }
  }
}
