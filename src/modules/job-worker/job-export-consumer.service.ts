import { type BeforeApplicationShutdown, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '#core/config/env.validation.ts';
import { RequestContext } from '#core/context/request-context.ts';
import { generateRequestId } from '#core/context/request-id.ts';
import { type QueueConsumer, QueueConsumerFactory, QueuePublisher, type ReceivedMessage } from '#infra/queue/queue.ts';
import { EXPORT_DISPATCH_TOPIC } from '#modules/job-outbox/job-outbox.constants.ts';
import { exportIdOf, requestIdOf } from '#modules/job-outbox/messages/job-dispatch.message.ts';
import { JobExportRunService } from '#modules/job-exports/job-export-run.service.ts';
import { toDeadLetter } from './dead-letter.ts';
import { JobWorkerLogEvent } from './job-worker.constants.ts';

const CONSUMER_GROUP = 'export-workers';

// Feeds background exports from the queue to JobExportRunService, at most
// EXPORT_WORKER_CONCURRENCY at once per worker: that limit, not the number of
// requests, sets how hard exports read the database (queue-based load leveling).
@Injectable()
export class JobExportConsumerService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(JobExportConsumerService.name);
  private readonly inFlight = new Set<Promise<boolean>>();
  private readonly stopping = new AbortController();
  private readonly concurrency: number;
  private consumer?: QueueConsumer;

  constructor(
    private readonly consumers: QueueConsumerFactory,
    private readonly publisher: QueuePublisher,
    private readonly runs: JobExportRunService,
    private readonly context: RequestContext,
    config: ConfigService<Env, true>,
  ) {
    this.concurrency = config.get('EXPORT_WORKER_CONCURRENCY', { infer: true });
  }

  async onApplicationBootstrap(): Promise<void> {
    this.consumer = this.consumers.create(CONSUMER_GROUP);
    await this.consumer.start({
      topic: EXPORT_DISPATCH_TOPIC,
      concurrency: this.concurrency,
      handler: (message) => this.track(this.handle(message)),
    });
  }

  // An export is cheap to start again, so shutdown does not wait for files to
  // finish: running exports go back to the queue at once, then the group is left.
  async beforeApplicationShutdown(): Promise<void> {
    this.consumer?.pause(EXPORT_DISPATCH_TOPIC);
    this.stopping.abort(new Error('Worker is shutting down.'));
    await Promise.allSettled(this.inFlight);
    await this.consumer?.stop();
  }

  private track(work: Promise<boolean>): Promise<boolean> {
    this.inFlight.add(work);
    return work.finally(() => this.inFlight.delete(work));
  }

  private async handle(message: ReceivedMessage): Promise<boolean> {
    const exportId = exportIdOf(message.value);
    if (!exportId) {
      // Names no export: it can never be processed, so it is parked, not retried.
      this.logger.error(JobWorkerLogEvent.MESSAGE_INVALID, { topic: message.topic, ...message.source });
      await this.publisher.publish([toDeadLetter(message)]);
      return true;
    }
    const requestId = requestIdOf(message.headers) ?? generateRequestId();
    return this.context.run({ requestId }, () => this.runs.process(exportId, requestId, this.stopping.signal));
  }
}
