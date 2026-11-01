import { Logger } from '@nestjs/common';
import { RequestContext } from '#core/context/request-context.ts';
import type { ConsumeOptions, ReceivedMessage } from '#infra/queue/queue.ts';
import { JobExportConsumerService } from './job-export-consumer.service.ts';

const EXPORT_ID = '0192f3a1-7c4e-7b2a-9d1f-3e5a8b6c2d10';
const REQUEST_ID = '4bf92f3577b34da6a3ce929d0e0e4736';

const message = (value: string | null, headers: Record<string, string> = {}): ReceivedMessage => ({
  topic: 'exports.process',
  key: EXPORT_ID,
  value,
  headers,
  source: { partition: '1', offset: '7' },
});

// The export consumer with the queue and the export runner replaced: the test
// delivers messages to the handler and plays the runner.
function setUp(process: (exportId: string, requestId: string, stop: AbortSignal) => Promise<boolean>): {
  service: JobExportConsumerService;
  deliver: (received: ReceivedMessage) => Promise<boolean>;
  consumer: { pause: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };
  runs: { process: ReturnType<typeof vi.fn> };
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
  const runs = { process: vi.fn(process) };
  const publish = vi.fn().mockResolvedValue(undefined);
  const config = { get: () => 2 };
  const service = new JobExportConsumerService(
    { create: () => consumer } as never,
    { publish } as never,
    runs as never,
    new RequestContext(),
    config as never,
  );
  const deliver = (received: ReceivedMessage): Promise<boolean> => {
    if (!options) {
      throw new Error('Consumer not started.');
    }
    return options.handler(received);
  };
  return { service, deliver, consumer, runs, publish };
}

describe('JobExportConsumerService', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => vi.restoreAllMocks());

  it('hands the export and the request that asked for it to the runner', async () => {
    const worker = setUp(() => Promise.resolve(true));
    await worker.service.onApplicationBootstrap();

    const handled = await worker.deliver(message(JSON.stringify({ export_id: EXPORT_ID }), { request_id: REQUEST_ID }));

    expect(handled).toBe(true);
    expect(worker.runs.process).toHaveBeenCalledWith(EXPORT_ID, REQUEST_ID, expect.any(AbortSignal));
  });

  it('parks a message that names no export on the dead letter topic, as it was', async () => {
    const worker = setUp(() => Promise.resolve(true));
    await worker.service.onApplicationBootstrap();

    const handled = await worker.deliver(message('{"job_id":"x"}', { request_id: REQUEST_ID }));

    expect(handled).toBe(true);
    expect(worker.runs.process).not.toHaveBeenCalled();
    expect(worker.publish).toHaveBeenCalledWith([
      {
        topic: 'exports.process.dlq',
        key: EXPORT_ID,
        value: '{"job_id":"x"}',
        headers: { request_id: REQUEST_ID, source_partition: '1', source_offset: '7' },
      },
    ]);
  });

  it('on shutdown stops taking exports, signals the running ones to stop, then leaves', async () => {
    let stop: AbortSignal | undefined;
    let finish: (value: boolean) => void = () => undefined;
    const worker = setUp((_exportId, _requestId, signal) => {
      stop = signal;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    await worker.service.onApplicationBootstrap();
    const running = worker.deliver(message(JSON.stringify({ export_id: EXPORT_ID })));

    const shutdown = worker.service.beforeApplicationShutdown();

    expect(worker.consumer.pause).toHaveBeenCalledWith('exports.process');
    expect(stop?.aborted).toBe(true);
    expect(worker.consumer.stop).not.toHaveBeenCalled();
    finish(true);
    await shutdown;
    await running;
    expect(worker.consumer.stop).toHaveBeenCalled();
  });
});
