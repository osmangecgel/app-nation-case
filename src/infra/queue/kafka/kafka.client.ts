import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { KafkaJS } from '@confluentinc/kafka-javascript';
import type { Env } from '#core/config/env.validation.ts';
import { kafkaLogger } from './kafka-logger.ts';

// The only place that builds the Kafka client. Modules see the queue ports
// (#infra/queue/queue.ts), never the broker library.
@Injectable()
export class KafkaClient {
  readonly kafka: KafkaJS.Kafka;

  constructor(config: ConfigService<Env, true>) {
    this.kafka = new KafkaJS.Kafka({
      kafkaJS: {
        clientId: config.get('KAFKA_CLIENT_ID', { infer: true }),
        brokers: config.get('KAFKA_BROKERS', { infer: true }).split(','),
        logLevel: KafkaJS.logLevel.WARN,
        logger: kafkaLogger(),
      },
    });
  }
}
