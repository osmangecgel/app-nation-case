// The queue as the rest of the code sees it. Modules depend only on these
// types; a broker (Kafka today) is an adapter folder next to this file that
// implements them, chosen by QUEUE_DRIVER (queue.module.ts). Every adapter must
// keep the contract written on each member, because the worker's correctness
// relies on it.

export type QueueMessage = {
  topic: string;
  // Messages with the same key are delivered to the same consumer where the
  // broker supports it (Kafka: same partition); other brokers may ignore it.
  key: string;
  value: string;
  headers: Record<string, string>;
};

export type ReceivedMessage = {
  topic: string;
  key: string | null;
  value: string | null;
  headers: Record<string, string>;
  // Where the broker kept the message, for logs and the dead letter record
  // (Kafka: partition and offset). Opaque to the handler.
  source: Record<string, string>;
};

// True when the message was handled. False leaves it to be delivered again,
// like a rejection, but without a warning: the handler chose to give it back.
export type MessageHandler = (message: ReceivedMessage) => Promise<boolean>;

export type ConsumeOptions = {
  topic: string;
  // Messages handled at once by this consumer.
  concurrency: number;
  // Must tolerate duplicates and any order. A message not handled (rejection
  // or false) is tried again after a pause, or left for redelivery on close.
  handler: MessageHandler;
};

// Abstract classes rather than interfaces: NestJS injects by a runtime token,
// and an interface does not exist at runtime.

// Resolves once the broker has accepted every message (durably, per the
// adapter's settings); rejects otherwise, so the outbox row stays unsent.
export abstract class QueuePublisher {
  abstract publish(messages: QueueMessage[]): Promise<void>;
}

// One member of a consumer group. Delivery is at-least-once: a message is
// acknowledged only after its handler returned true, and one the consumer was
// still handling when it died is delivered again.
export interface QueueConsumer {
  start(options: ConsumeOptions): Promise<void>;
  // Stops starting new messages; handlers already running continue.
  pause(topic: string): void;
  // Leaves the group; unacknowledged messages go to other members.
  stop(): Promise<void>;
}

export abstract class QueueConsumerFactory {
  abstract create(groupId: string): QueueConsumer;
}
