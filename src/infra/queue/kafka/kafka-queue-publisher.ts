import { Injectable, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import type { KafkaJS } from '@confluentinc/kafka-javascript';
import { type QueueMessage, QueuePublisher } from '#infra/queue/queue.ts';
import { KafkaClient } from './kafka.client.ts';

// How long a send may take before it fails; the outbox relay holds its row
// locks for at most this long.
const SEND_TIMEOUT_MS = 10_000;

// Publishes to Kafka. Idempotent producer with acks from all in-sync replicas:
// a network retry inside one producer session is not written twice, and an
// acknowledged message survives a broker failure. Duplicates across producer
// restarts are still possible; consumers deduplicate by job state.
@Injectable()
export class KafkaQueuePublisher extends QueuePublisher implements OnModuleInit, OnApplicationShutdown {
  private readonly producer: KafkaJS.Producer;

  constructor(client: KafkaClient) {
    super();
    this.producer = client.kafka.producer({
      kafkaJS: { idempotent: true, acks: -1 },
      'message.timeout.ms': SEND_TIMEOUT_MS,
    });
  }

  async onModuleInit(): Promise<void> {
    await this.producer.connect();
  }

  // Closed in the last shutdown step, after beforeApplicationShutdown: the
  // worker's grace period still publishes retries and dead letters.
  async onApplicationShutdown(): Promise<void> {
    await this.producer.disconnect();
  }

  async publish(messages: QueueMessage[]): Promise<void> {
    const byTopic = new Map<string, QueueMessage[]>();
    for (const message of messages) {
      byTopic.set(message.topic, [...(byTopic.get(message.topic) ?? []), message]);
    }
    await this.producer.sendBatch({
      topicMessages: [...byTopic].map(([topic, topicMessages]) => ({
        topic,
        messages: topicMessages.map(({ key, value, headers }) => ({ key, value, headers })),
      })),
    });
  }
}
