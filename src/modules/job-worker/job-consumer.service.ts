import { type BeforeApplicationShutdown, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '#core/config/env.validation.ts';
import { generateRequestId } from '#core/context/request-id.ts';
import { type QueueConsumer, QueueConsumerFactory, QueuePublisher, type ReceivedMessage } from '#infra/queue/queue.ts';
import { JOB_DISPATCH_TOPIC } from '#modules/job-outbox/job-outbox.constants.ts';
import { jobIdOf, requestIdOf } from '#modules/job-outbox/messages/job-dispatch.message.ts';
import { describeError } from '#shared/describe-error.ts';
import { sleep } from '#shared/sleep.ts';
import { toDeadLetter } from './dead-letter.ts';
import { JobProcessorService } from './job-processor.service.ts';
import { JobWorkerLogEvent } from './job-worker.constants.ts';

const CONSUMER_GROUP = 'job-workers';

// Feeds jobs from the queue to the processor. A message only names a job; its
// state is in the database, so a duplicate or late message is harmless.
@Injectable()
export class JobConsumerService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(JobConsumerService.name);
  private readonly inFlight = new Set<Promise<boolean>>();
  private readonly concurrency: number;
  private readonly shutdownGraceMs: number;
  private consumer?: QueueConsumer;

  constructor(
    private readonly consumers: QueueConsumerFactory,
    private readonly publisher: QueuePublisher,
    private readonly processor: JobProcessorService,
    config: ConfigService<Env, true>,
  ) {
    this.concurrency = config.get('WORKER_JOB_CONCURRENCY', { infer: true });
    this.shutdownGraceMs = config.get('WORKER_SHUTDOWN_GRACE_MS', { infer: true });
  }

  async onApplicationBootstrap(): Promise<void> {
    this.consumer = this.consumers.create(CONSUMER_GROUP);
    await this.consumer.start({
      topic: JOB_DISPATCH_TOPIC,
      concurrency: this.concurrency,
      handler: (message) => this.track(this.handle(message)),
    });
    this.logger.log(JobWorkerLogEvent.WORKER_STARTED, { concurrency: this.concurrency });
  }

  // SIGTERM: stop taking jobs, hand back the ones not claimed yet (they are
  // delivered again), give claimed jobs the grace period to finish, then
  // interrupt the rest (they go back to the queue) and leave the group.
  async beforeApplicationShutdown(): Promise<void> {
    this.logger.log(JobWorkerLogEvent.WORKER_STOPPING, { inFlight: this.inFlight.size });
    this.consumer?.pause(JOB_DISPATCH_TOPIC);
    this.processor.stopTakingJobs();
    const finished = Promise.allSettled(this.inFlight);
    await Promise.race([finished, sleep(this.shutdownGraceMs)]);
    if (this.inFlight.size > 0) {
      this.processor.interruptInFlight();
      await Promise.allSettled(this.inFlight);
    }
    await this.consumer?.stop();
    this.logger.log(JobWorkerLogEvent.WORKER_STOPPED);
  }

  private track(work: Promise<boolean>): Promise<boolean> {
    this.inFlight.add(work);
    return work.finally(() => this.inFlight.delete(work));
  }

  private async handle(message: ReceivedMessage): Promise<boolean> {
    const jobId = jobIdOf(message.value);
    if (!jobId) {
      await this.deadLetter(message);
      return true;
    }
    try {
      return await this.processor.process(jobId, requestIdOf(message.headers) ?? generateRequestId());
    } catch (error) {
      // An infrastructure error (the database is down). The consumer retries
      // the message after a pause; on shutdown it is delivered again later.
      this.logger.error(JobWorkerLogEvent.JOB_PROCESSING_FAILED, { jobId, reason: describeError(error) });
      throw error;
    }
  }

  // A message that names no job can never be processed; it is parked on the
  // dead letter topic instead of blocking its partition.
  private async deadLetter(message: ReceivedMessage): Promise<void> {
    this.logger.error(JobWorkerLogEvent.MESSAGE_INVALID, message.source);
    await this.publisher.publish([toDeadLetter(message)]);
  }
}
