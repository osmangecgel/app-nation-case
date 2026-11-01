import { Logger } from '@nestjs/common';
import type { ConsumeOptions, ReceivedMessage } from '#infra/queue/queue.ts';
import { JobConsumerService } from './job-consumer.service.ts';

const JOB_ID = '0192f3a1-7c4e-7b2a-9d1f-3e5a8b6c2d10';
const REQUEST_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const GRACE_MS = 1_000;

const message = (value: string | null, headers: Record<string, string> = {}): ReceivedMessage => ({
  topic: 'jobs.process',
  key: 'content-hash',
  value,
  headers,
  source: { partition: '3', offset: '42' },
});

// The worker's Kafka side with every collaborator replaced: the test delivers
// messages to the handler and plays the processor.
function setUp(process: (jobId: string, requestId: string) => Promise<boolean>): {
  service: JobConsumerService;
  deliver: (received: ReceivedMessage) => Promise<boolean>;
  consumer: { pause: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };
  processor: {
    process: ReturnType<typeof vi.fn>;
    stopTakingJobs: ReturnType<typeof vi.fn>;
    interruptInFlight: ReturnType<typeof vi.fn>;
  };
  publish: ReturnType<typeof vi.fn>;
} {
  let options: ConsumeOptions | undefined;
  const consumer = {
    start: vi.fn((given: ConsumeOptions) => {
      options = given;
      return Promise.resolve();
    }),
    pause: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
  };
  const processor = { process: vi.fn(process), stopTakingJobs: vi.fn(), interruptInFlight: vi.fn() };
  const publish = vi.fn().mockResolvedValue(undefined);
  const config = { get: (key: string) => (key === 'WORKER_SHUTDOWN_GRACE_MS' ? GRACE_MS : 8) };
  const service = new JobConsumerService(
    { create: () => consumer } as never,
    { publish } as never,
    processor as never,
    config as never,
  );
  const deliver = (received: ReceivedMessage): Promise<boolean> => {
    if (!options) {
      throw new Error('Consumer not started.');
    }
    return options.handler(received);
  };
  return { service, deliver, consumer, processor, publish };
}

describe('JobConsumerService', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('hands the job and the request that created it to the processor', async () => {
    const worker = setUp(() => Promise.resolve(true));
    await worker.service.onApplicationBootstrap();

    const handled = await worker.deliver(message(JSON.stringify({ job_id: JOB_ID }), { request_id: REQUEST_ID }));

    expect(handled).toBe(true);
    expect(worker.processor.process).toHaveBeenCalledWith(JOB_ID, REQUEST_ID);
  });

  it('gives a message back when the processor gave its job up', async () => {
    const worker = setUp(() => Promise.resolve(false));
    await worker.service.onApplicationBootstrap();

    expect(await worker.deliver(message(JSON.stringify({ job_id: JOB_ID })))).toBe(false);
  });

  it('makes up a request id for a message without one', async () => {
    const worker = setUp(() => Promise.resolve(true));
    await worker.service.onApplicationBootstrap();

    await worker.deliver(message(JSON.stringify({ job_id: JOB_ID })));

    expect(worker.processor.process).toHaveBeenCalledWith(JOB_ID, expect.stringMatching(/^[0-9a-f]{32}$/));
  });

  it.each([
    ['not JSON', 'not json'],
    ['JSON without a job id', JSON.stringify({ id: JOB_ID })],
    ['an empty message', null],
  ])('parks %s on the dead letter topic instead of blocking its partition', async (_case, value) => {
    const worker = setUp(() => Promise.resolve(true));
    await worker.service.onApplicationBootstrap();

    expect(await worker.deliver(message(value, { request_id: REQUEST_ID }))).toBe(true);

    expect(worker.processor.process).not.toHaveBeenCalled();
    expect(worker.publish).toHaveBeenCalledWith([
      {
        topic: 'jobs.process.dlq',
        key: 'content-hash',
        value: value ?? '',
        headers: { request_id: REQUEST_ID, source_partition: '3', source_offset: '42' },
      },
    ]);
  });

  it('lets an infrastructure error through, so the consumer tries the message again', async () => {
    const worker = setUp(() => Promise.reject(new Error('database down')));
    await worker.service.onApplicationBootstrap();

    await expect(worker.deliver(message(JSON.stringify({ job_id: JOB_ID })))).rejects.toThrow('database down');
  });

  describe('on SIGTERM', () => {
    it('stops taking jobs, lets running ones finish, then leaves the group', async () => {
      let finish = (): void => undefined;
      const worker = setUp(() => new Promise((resolve) => (finish = () => resolve(true))));
      await worker.service.onApplicationBootstrap();
      const running = worker.deliver(message(JSON.stringify({ job_id: JOB_ID })));

      const stopping = worker.service.beforeApplicationShutdown();
      expect(worker.consumer.pause).toHaveBeenCalledWith('jobs.process');
      expect(worker.processor.stopTakingJobs).toHaveBeenCalled();
      expect(worker.consumer.stop).not.toHaveBeenCalled();

      finish();
      await stopping;
      await running;
      expect(worker.processor.interruptInFlight).not.toHaveBeenCalled();
      expect(worker.consumer.stop).toHaveBeenCalled();
    });

    it('interrupts jobs still running after the grace period', async () => {
      vi.useFakeTimers();
      let finish = (): void => undefined;
      const worker = setUp(() => new Promise((resolve) => (finish = () => resolve(true))));
      worker.processor.interruptInFlight.mockImplementation(() => finish());
      await worker.service.onApplicationBootstrap();
      void worker.deliver(message(JSON.stringify({ job_id: JOB_ID })));

      const stopping = worker.service.beforeApplicationShutdown();
      await vi.advanceTimersByTimeAsync(GRACE_MS);
      await stopping;

      expect(worker.processor.interruptInFlight).toHaveBeenCalled();
      expect(worker.consumer.stop).toHaveBeenCalled();
    });
  });
});
