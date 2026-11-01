import { Module } from '@nestjs/common';
import { QueueConsumerFactory, QueuePublisher } from '#infra/queue/queue.ts';
import { KafkaClient } from './kafka.client.ts';
import { KafkaQueueConsumerFactory } from './kafka-queue-consumer.ts';
import { KafkaQueuePublisher } from './kafka-queue-publisher.ts';

// The Kafka driver: binds the queue ports to their Kafka adapters. Loaded by
// QueueModule when QUEUE_DRIVER=kafka; nothing else imports this folder.
@Module({
  providers: [
    KafkaClient,
    { provide: QueuePublisher, useClass: KafkaQueuePublisher },
    { provide: QueueConsumerFactory, useClass: KafkaQueueConsumerFactory },
  ],
  exports: [QueuePublisher, QueueConsumerFactory],
})
export class KafkaQueueModule {}
