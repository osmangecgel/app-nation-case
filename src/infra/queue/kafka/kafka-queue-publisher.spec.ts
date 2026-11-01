import type { KafkaClient } from './kafka.client.ts';
import { KafkaQueuePublisher } from './kafka-queue-publisher.ts';

function fakeKafka(): { client: KafkaClient; sendBatch: ReturnType<typeof vi.fn>; config: () => object } {
  const sendBatch = vi.fn().mockResolvedValue(undefined);
  let producerConfig: object = {};
  const client = {
    kafka: {
      producer: (config: object) => {
        producerConfig = config;
        return { connect: vi.fn(), disconnect: vi.fn(), sendBatch };
      },
    },
  };
  return { client: client as never, sendBatch, config: () => producerConfig };
}

describe('KafkaQueuePublisher', () => {
  it('waits for every in-sync replica and does not write a network retry twice', () => {
    const kafka = fakeKafka();

    new KafkaQueuePublisher(kafka.client);

    expect(kafka.config()).toMatchObject({ kafkaJS: { idempotent: true, acks: -1 } });
  });

  it('sends messages for several topics in one batch, grouped by topic', async () => {
    const kafka = fakeKafka();
    const publisher = new KafkaQueuePublisher(kafka.client);
    const message = (topic: string, key: string) => ({ topic, key, value: '{}', headers: { request_id: 'r' } });

    await publisher.publish([
      message('jobs.process', 'a'),
      message('jobs.process.dlq', 'b'),
      message('jobs.process', 'c'),
    ]);

    expect(kafka.sendBatch).toHaveBeenCalledWith({
      topicMessages: [
        {
          topic: 'jobs.process',
          messages: [
            { key: 'a', value: '{}', headers: { request_id: 'r' } },
            { key: 'c', value: '{}', headers: { request_id: 'r' } },
          ],
        },
        { topic: 'jobs.process.dlq', messages: [{ key: 'b', value: '{}', headers: { request_id: 'r' } }] },
      ],
    });
  });
});
