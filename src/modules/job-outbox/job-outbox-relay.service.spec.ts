import { Logger } from '@nestjs/common';
import { RequestContext } from '#core/context/request-context.ts';
import { JobOutboxRelayService } from './job-outbox-relay.service.ts';

const INTERVAL_MS = 200;

const pendingRow = {
  id: '0192f3a1-7c4e-7b2a-9d1f-3e5a8b6c2d10',
  job_id: '0192f3a1-7c4e-7b2a-9d1f-3e5a8b6c2d11',
  topic: 'jobs.process',
  message_key: 'content-hash',
  request_id: '4bf92f3577b34da6a3ce929d0e0e4736',
};

// The relay with its database and broker replaced; the test decides when the
// broker acknowledges.
function setUp(): { relay: JobOutboxRelayService; acknowledge: () => void; published: ReturnType<typeof vi.fn> } {
  let acknowledge = (): void => undefined;
  const published = vi.fn(() => new Promise<void>((resolve) => (acknowledge = resolve)));
  const tx = { $queryRaw: vi.fn().mockResolvedValueOnce([pendingRow]), $executeRaw: vi.fn().mockResolvedValue(1) };
  const prisma = {
    $transaction: (work: (client: typeof tx) => Promise<number>) => work(tx),
    $executeRaw: vi.fn().mockResolvedValue(0),
  };
  const config = { get: () => INTERVAL_MS };
  const context = new RequestContext();
  const relay = new JobOutboxRelayService(prisma as never, { publish: published } as never, context, config as never);
  return { relay, acknowledge: () => acknowledge(), published };
}

describe('JobOutboxRelayService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('lets a running round finish before shutdown completes, so its connections are not closed under it', async () => {
    const { relay, acknowledge, published } = setUp();
    relay.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(published).toHaveBeenCalledTimes(1);

    let stopped = false;
    const shutdown = relay.onApplicationShutdown().then(() => (stopped = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);

    acknowledge();
    await shutdown;
    expect(stopped).toBe(true);
  });

  it('starts no round after shutdown', async () => {
    const { relay, published } = setUp();
    relay.onApplicationBootstrap();

    await relay.onApplicationShutdown();
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3);

    expect(published).not.toHaveBeenCalled();
  });
});
