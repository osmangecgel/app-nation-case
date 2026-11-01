import { type DynamicModule, Module, type Type } from '@nestjs/common';
import type { QueueDriver } from '#core/config/env.constants.ts';
import { loadedEnv } from '#core/config/loaded-env.ts';
import { KafkaQueueModule } from './kafka/kafka-queue.module.ts';

// Every broker this build supports. A new broker is a folder that binds
// QueuePublisher and QueueConsumerFactory (see kafka/kafka-queue.module.ts),
// one entry here and one value in QueueDriver; no module changes.
const QUEUE_DRIVERS: Record<QueueDriver, Type> = {
  kafka: KafkaQueueModule,
};

// Gives modules the queue ports (queue.ts) bound to the driver QUEUE_DRIVER
// names. Only that driver is loaded, so the others open no connections.
@Module({})
export class QueueModule {
  static async register(): Promise<DynamicModule> {
    const driver = QUEUE_DRIVERS[(await loadedEnv()).QUEUE_DRIVER];
    return { module: QueueModule, imports: [driver], exports: [driver] };
  }
}
