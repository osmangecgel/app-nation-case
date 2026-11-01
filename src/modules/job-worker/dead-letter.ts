import type { QueueMessage, ReceivedMessage } from '#infra/queue/queue.ts';

// A message that can never be processed, as it arrived, for the topic's
// dead letter topic (QUEUE-12); the source headers say where it came from.
export function toDeadLetter(message: ReceivedMessage): QueueMessage {
  const source = Object.entries(message.source).map(([name, value]) => [`source_${name}`, value]);
  return {
    topic: `${message.topic}.dlq`,
    key: message.key ?? '',
    value: message.value ?? '',
    headers: { ...message.headers, ...Object.fromEntries(source) },
  };
}
