import { Injectable, Logger } from '@nestjs/common';
import { KafkaJS } from '@confluentinc/kafka-javascript';
import { describeError } from '#shared/describe-error.ts';
import { Semaphore } from '#shared/semaphore.ts';
import { sleep } from '#shared/sleep.ts';
import {
  type ConsumeOptions,
  type MessageHandler,
  type QueueConsumer,
  QueueConsumerFactory,
  type ReceivedMessage,
} from '#infra/queue/queue.ts';
import { KafkaClient } from './kafka.client.ts';
import { PartitionProgress } from './partition-progress.ts';

type TopicPartition = { topic: string; partition: number };

// A received message with where it sits in Kafka, which commits need.
type PartitionMessage = TopicPartition & { offset: string; received: ReceivedMessage };

function partitionKey(target: TopicPartition): string {
  return `${target.topic}:${target.partition}`;
}

// Group membership: a worker that stops heartbeating loses its partitions to
// the other workers after this long.
const SESSION_TIMEOUT_MS = 10_000;
const HEARTBEAT_INTERVAL_MS = 3_000;

// Bounds the messages fetched ahead of processing. librdkafka's default is up
// to 100,000 messages per partition, which would make worker memory grow with
// the backlog.
const PREFETCH_MESSAGES = 50;
const PREFETCH_KBYTES = 1_024;

// Messages a partition may have started but not committed: what a crash or a
// rebalance delivers again. Past it, the partition waits for its oldest message.
const MAX_UNCOMMITTED_PER_PARTITION = 1_000;
const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_MAX_DELAY_MS = 30_000;

const QueueLogEvent = {
  MESSAGE_RETRY_SCHEDULED: 'MESSAGE_RETRY_SCHEDULED',
  OFFSET_COMMIT_FAILED: 'OFFSET_COMMIT_FAILED',
} as const;

function headerValue(value: Buffer | string | (Buffer | string)[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  return first === undefined ? undefined : first.toString();
}

function toReceived(topic: string, partition: number, message: KafkaJS.KafkaMessage): PartitionMessage {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(message.headers ?? {})) {
    const text = headerValue(value);
    if (text !== undefined) {
      headers[name] = text;
    }
  }
  return {
    topic,
    partition,
    offset: message.offset,
    received: {
      topic,
      key: message.key?.toString() ?? null,
      value: message.value?.toString() ?? null,
      headers,
      source: { partition: String(partition), offset: message.offset },
    },
  };
}

// One consumer group member (QueueConsumer on Kafka).
//
// Messages of one partition are handled side by side, not one after another:
// a slow message (a provider call that runs into its timeout) would otherwise
// hold up every message behind it on its partition, and throughput would be
// capped by the partition count instead of by the workers.
//
// Offsets are still committed in order (see PartitionProgress): an offset is
// committed only once every message before it has been handled, so a worker
// that dies leaves its unfinished messages to be delivered again
// (at-least-once). Messages that finished after the oldest unfinished one are
// delivered again too; handlers must tolerate duplicates.
export class KafkaQueueConsumer implements QueueConsumer {
  private readonly logger = new Logger(KafkaQueueConsumer.name);
  private readonly consumer: KafkaJS.Consumer;
  private readonly partitions = new Map<string, PartitionProgress>();
  // One commit at a time per partition, so offsets reach Kafka in order.
  private readonly commits = new Map<string, Promise<void>>();
  // Messages being handled, up to their commit.
  private readonly handling = new Set<Promise<void>>();
  private readonly closing = new AbortController();

  constructor(client: KafkaClient, groupId: string) {
    this.consumer = client.kafka.consumer({
      kafkaJS: {
        groupId,
        fromBeginning: true,
        autoCommit: false,
        sessionTimeout: SESSION_TIMEOUT_MS,
        heartbeatInterval: HEARTBEAT_INTERVAL_MS,
      },
      'queued.min.messages': PREFETCH_MESSAGES,
      'queued.max.messages.kbytes': PREFETCH_KBYTES,
      rebalance_cb: (error: { code: number }, assignment: TopicPartition[]) => this.onRebalance(error, assignment),
    });
  }

  async start(options: ConsumeOptions): Promise<void> {
    const slots = new Semaphore(options.concurrency);
    await this.consumer.connect();
    await this.consumer.subscribe({ topics: [options.topic] });
    await this.consumer.run({
      partitionsConsumedConcurrently: options.concurrency,
      // Returns once the message has started, so the next one can be taken.
      eachMessage: async ({ topic, partition, message }) => {
        const progress = this.progressOf({ topic, partition });
        let release: () => void;
        try {
          await progress.waitForRoom(this.closing.signal);
          release = await slots.acquire(this.closing.signal);
        } catch {
          // Closing: the message was not started and is not committed.
          return;
        }
        if (progress.revoked) {
          release();
          return;
        }
        const offset = BigInt(message.offset);
        progress.start(offset);
        const work = this.handle(options.handler, toReceived(topic, partition, message), progress).finally(() => {
          release();
          this.handling.delete(work);
        });
        this.handling.add(work);
      },
    });
  }

  // Stops fetching and starting messages; handlers already running continue.
  pause(topic: string): void {
    this.closing.abort(new Error('Consumer is closing.'));
    this.consumer.pause([{ topic }]);
  }

  // Leaves the group, so its partitions move to other workers at once. First
  // lets messages whose handler has finished reach their commit: the caller
  // waits for its handlers, but the commit comes a few steps after them.
  async stop(): Promise<void> {
    this.closing.abort(new Error('Consumer is closing.'));
    await Promise.allSettled(this.handling);
    await Promise.allSettled(this.commits.values());
    await this.consumer.disconnect();
  }

  private progressOf(target: TopicPartition): PartitionProgress {
    const key = partitionKey(target);
    let progress = this.partitions.get(key);
    if (!progress) {
      progress = new PartitionProgress(MAX_UNCOMMITTED_PER_PARTITION);
      this.partitions.set(key, progress);
    }
    return progress;
  }

  // Retries until the handler succeeds. When the consumer closes first, the
  // message stays uncommitted and is delivered again.
  private async handle(handler: MessageHandler, message: PartitionMessage, progress: PartitionProgress): Promise<void> {
    for (let attempt = 0; !(await this.tryHandle(handler, message, attempt)); attempt += 1) {
      const delayMs = Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS);
      try {
        await sleep(delayMs, this.closing.signal);
      } catch {
        return;
      }
    }
    const commitTo = progress.finish(BigInt(message.offset));
    if (commitTo !== null) {
      this.commit({ topic: message.topic, partition: message.partition }, commitTo);
    }
  }

  private async tryHandle(handler: MessageHandler, message: PartitionMessage, attempt: number): Promise<boolean> {
    try {
      return await handler(message.received);
    } catch (error) {
      this.logger.warn(QueueLogEvent.MESSAGE_RETRY_SCHEDULED, {
        topic: message.topic,
        partition: message.partition,
        offset: message.offset,
        attempt,
        reason: describeError(error),
      });
      return false;
    }
  }

  private commit(target: TopicPartition, offset: bigint): void {
    const key = partitionKey(target);
    const previous = this.commits.get(key) ?? Promise.resolve();
    const next = previous
      .then(() => this.consumer.commitOffsets([{ ...target, offset: offset.toString() }]))
      // A lost commit only means redelivery of messages already handled.
      .catch((error: Error) =>
        this.logger.warn(QueueLogEvent.OFFSET_COMMIT_FAILED, { ...target, reason: describeError(error) }),
      );
    this.commits.set(key, next);
  }

  // Partitions taken away stop committing; a partition assigned again later
  // starts fresh from the offset Kafka has.
  private onRebalance(error: { code: number }, assignment: TopicPartition[]): void {
    if (error.code !== KafkaJS.ErrorCodes.ERR__REVOKE_PARTITIONS) {
      return;
    }
    for (const target of assignment) {
      const key = partitionKey(target);
      this.partitions.get(key)?.revoke();
      this.partitions.delete(key);
    }
  }
}

@Injectable()
export class KafkaQueueConsumerFactory extends QueueConsumerFactory {
  constructor(private readonly client: KafkaClient) {
    super();
  }

  create(groupId: string): QueueConsumer {
    return new KafkaQueueConsumer(this.client, groupId);
  }
}
