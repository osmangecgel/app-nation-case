import { Logger } from '@nestjs/common';
import { KafkaJS } from '@confluentinc/kafka-javascript';
import type { KafkaClient } from './kafka.client.ts';
import type { ReceivedMessage } from '#infra/queue/queue.ts';
import { KafkaQueueConsumer } from './kafka-queue-consumer.ts';

const TOPIC = 'jobs.process';

type EachMessage = (payload: {
  topic: string;
  partition: number;
  message: { offset: string; key: Buffer | null; value: Buffer | null; headers: Record<string, Buffer> };
}) => Promise<void>;
type Commit = (offsets: Array<{ topic: string; partition: number; offset: string }>) => Promise<void>;
type RebalanceCallback = (error: { code: number }, assignment: Array<{ topic: string; partition: number }>) => void;

// Stands in for the broker library: tests deliver messages and rebalances by hand.
function fakeKafka(): {
  client: KafkaClient;
  commitOffsets: ReturnType<typeof vi.fn<Commit>>;
  disconnect: ReturnType<typeof vi.fn>;
  deliver: (partition: number, offset: number) => Promise<void>;
  revoke: (partition: number) => void;
} {
  let eachMessage: EachMessage | undefined;
  let rebalance: RebalanceCallback | undefined;
  const commitOffsets = vi.fn<Commit>().mockResolvedValue(undefined);
  const consumer = {
    connect: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockResolvedValue(undefined),
    run: vi.fn((config: { eachMessage: EachMessage }) => {
      eachMessage = config.eachMessage;
      return Promise.resolve();
    }),
    commitOffsets,
    pause: vi.fn(),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };
  const client = {
    kafka: {
      consumer: (config: { rebalance_cb: RebalanceCallback }) => {
        rebalance = config.rebalance_cb;
        return consumer;
      },
    },
  };
  return {
    client: client as never,
    commitOffsets,
    disconnect: consumer.disconnect,
    deliver: (partition, offset) => {
      if (!eachMessage) {
        throw new Error('Consumer not started.');
      }
      return eachMessage({
        topic: TOPIC,
        partition,
        message: { offset: String(offset), key: null, value: Buffer.from(`m${offset}`), headers: {} },
      });
    },
    revoke: (partition) =>
      rebalance?.({ code: KafkaJS.ErrorCodes.ERR__REVOKE_PARTITIONS }, [{ topic: TOPIC, partition }]),
  };
}

// A handler whose calls stay running until the test finishes them.
function controllableHandler(): {
  handler: (message: ReceivedMessage) => Promise<boolean>;
  running: string[];
  finish: (value: string) => Promise<void>;
} {
  const pending = new Map<string, () => void>();
  const running: string[] = [];
  return {
    running,
    handler: (message) =>
      new Promise((resolve) => {
        running.push(message.value ?? '');
        pending.set(message.value ?? '', () => resolve(true));
      }),
    finish: async (value) => {
      pending.get(value)?.();
      // Lets the consumer record the result and commit.
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

function committed(commitOffsets: ReturnType<typeof vi.fn<Commit>>): string[] {
  return commitOffsets.mock.calls.map(([offsets]) => offsets[0]?.offset ?? '');
}

describe('KafkaQueueConsumer', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('handles messages of one partition side by side', async () => {
    const kafka = fakeKafka();
    const { handler, running } = controllableHandler();
    await new KafkaQueueConsumer(kafka.client, 'group').start({ topic: TOPIC, concurrency: 4, handler });

    await kafka.deliver(0, 0);
    await kafka.deliver(0, 1);

    expect(running).toEqual(['m0', 'm1']);
  });

  it('commits a message only when every older one has finished', async () => {
    const kafka = fakeKafka();
    const { handler, finish } = controllableHandler();
    await new KafkaQueueConsumer(kafka.client, 'group').start({ topic: TOPIC, concurrency: 4, handler });
    await kafka.deliver(0, 0);
    await kafka.deliver(0, 1);

    await finish('m1');
    expect(committed(kafka.commitOffsets)).toEqual([]);

    await finish('m0');
    expect(committed(kafka.commitOffsets)).toEqual(['2']);
  });

  it('keeps partitions apart', async () => {
    const kafka = fakeKafka();
    const { handler, finish } = controllableHandler();
    await new KafkaQueueConsumer(kafka.client, 'group').start({ topic: TOPIC, concurrency: 4, handler });
    await kafka.deliver(0, 0);
    await kafka.deliver(1, 7);

    await finish('m7');

    expect(kafka.commitOffsets).toHaveBeenCalledWith([{ topic: TOPIC, partition: 1, offset: '8' }]);
  });

  it('takes no more messages than its concurrency allows', async () => {
    const kafka = fakeKafka();
    const { handler, running, finish } = controllableHandler();
    await new KafkaQueueConsumer(kafka.client, 'group').start({ topic: TOPIC, concurrency: 1, handler });
    await kafka.deliver(0, 0);

    const second = kafka.deliver(0, 1);
    await new Promise((resolve) => setImmediate(resolve));
    expect(running).toEqual(['m0']);

    await finish('m0');
    await second;
    expect(running).toEqual(['m0', 'm1']);
  });

  it('retries a failing handler and commits once it succeeds', async () => {
    vi.useFakeTimers();
    const kafka = fakeKafka();
    const handler = vi.fn().mockRejectedValueOnce(new Error('database down')).mockResolvedValue(true);
    await new KafkaQueueConsumer(kafka.client, 'group').start({ topic: TOPIC, concurrency: 4, handler });

    await kafka.deliver(0, 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(committed(kafka.commitOffsets)).toEqual([]);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(committed(kafka.commitOffsets)).toEqual(['1']);
  });

  it('delivers a message the handler gave back again', async () => {
    vi.useFakeTimers();
    const kafka = fakeKafka();
    const handler = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    await new KafkaQueueConsumer(kafka.client, 'group').start({ topic: TOPIC, concurrency: 4, handler });

    await kafka.deliver(0, 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(committed(kafka.commitOffsets)).toEqual([]);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(committed(kafka.commitOffsets)).toEqual(['1']);
  });

  it('commits nothing for a partition it lost', async () => {
    const kafka = fakeKafka();
    const { handler, finish } = controllableHandler();
    await new KafkaQueueConsumer(kafka.client, 'group').start({ topic: TOPIC, concurrency: 4, handler });
    await kafka.deliver(0, 0);

    kafka.revoke(0);
    await finish('m0');

    expect(kafka.commitOffsets).not.toHaveBeenCalled();
  });

  it('commits a message that finished just before stop, before leaving the group', async () => {
    const kafka = fakeKafka();
    const { handler, finish } = controllableHandler();
    const consumer = new KafkaQueueConsumer(kafka.client, 'group');
    await consumer.start({ topic: TOPIC, concurrency: 4, handler });
    await kafka.deliver(0, 0);

    // The handler finishes and stop() is called in the same turn, as on SIGTERM
    // when the worker's grace period ends with the last job.
    void finish('m0');
    await consumer.stop();

    expect(committed(kafka.commitOffsets)).toEqual(['1']);
    expect(kafka.commitOffsets.mock.invocationCallOrder[0]).toBeLessThan(
      kafka.disconnect.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('gives up retrying on stop and leaves the message for redelivery', async () => {
    vi.useFakeTimers();
    const kafka = fakeKafka();
    const handler = vi.fn().mockRejectedValue(new Error('database down'));
    const consumer = new KafkaQueueConsumer(kafka.client, 'group');
    await consumer.start({ topic: TOPIC, concurrency: 4, handler });
    await kafka.deliver(0, 0);
    await vi.advanceTimersByTimeAsync(0);

    await consumer.stop();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(kafka.commitOffsets).not.toHaveBeenCalled();
  });
});
