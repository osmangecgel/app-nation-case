import { EventEmitter } from 'node:events';
import { Logger } from '@nestjs/common';
import { EXPORT_BATCH_SIZE } from './job-exports.constants.ts';
import { JobExportService } from './job-export.service.ts';

const row = (n: number) => ({
  id: `0192f3a1-7c4e-7b2a-9d1f-${String(n).padStart(12, '0')}`,
  status: 'completed',
  error_code: null,
  cost: 1,
  created_at: new Date('2026-10-30T10:00:00.000Z'),
  finished_at: new Date('2026-10-30T10:00:01.000Z'),
  content: { job_type_code: 'translate' },
});

const batch = (from: number, size: number) => Array.from({ length: size }, (_, index) => row(from + index));

// An HTTP response the test controls: write() reports a full buffer while
// `slow` is set, as a client that reads slowly makes it do.
class FakeResponse extends EventEmitter {
  slow = false;
  // Like a real response: once the client has gone, writes report a full buffer
  // and 'drain' never comes.
  destroyed = false;
  readonly chunks: string[] = [];
  readonly end = vi.fn();
  readonly destroy = vi.fn();

  goAway(): void {
    this.destroyed = true;
    this.emit('close');
  }

  status(): this {
    return this;
  }

  type(): this {
    return this;
  }

  setHeader(): this {
    return this;
  }

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return !this.slow && !this.destroyed;
  }
}

function setUp(findMany: ReturnType<typeof vi.fn>): { service: JobExportService; response: FakeResponse } {
  const prisma = { job: { findMany } };
  return { service: new JobExportService(prisma as never), response: new FakeResponse() };
}

// Lets the export run until it waits for the client or the database.
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('JobExportService', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => vi.restoreAllMocks());

  it('reads the jobs in batches, each starting after the last row of the one before', async () => {
    const findMany = vi
      .fn()
      .mockResolvedValueOnce(batch(0, EXPORT_BATCH_SIZE))
      .mockResolvedValueOnce(batch(EXPORT_BATCH_SIZE, 2));
    const { service, response } = setUp(findMany);

    await service.writeCsv('user-1', response as never);

    expect(findMany).toHaveBeenCalledTimes(2);
    expect(findMany.mock.calls[1]?.[0]).toMatchObject({
      where: { user_id: 'user-1', id: { lt: row(EXPORT_BATCH_SIZE - 1).id } },
    });
    // The header and one chunk per batch.
    expect(response.chunks).toHaveLength(3);
    expect(response.end).toHaveBeenCalled();
  });

  it('reads the next batch only after a slow client has caught up', async () => {
    const findMany = vi.fn().mockResolvedValueOnce(batch(0, EXPORT_BATCH_SIZE)).mockResolvedValueOnce([]);
    const { service, response } = setUp(findMany);
    response.slow = true;

    const done = service.writeCsv('user-1', response as never);
    await settle();
    expect(findMany).toHaveBeenCalledTimes(0);

    response.emit('drain');
    await settle();
    expect(findMany).toHaveBeenCalledTimes(1);

    response.slow = false;
    response.emit('drain');
    await done;
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it('stops reading the database when the client goes away', async () => {
    // A user with endless jobs; each query answers after a turn of the event
    // loop, like a real one, so the client's 'close' can arrive in between.
    const findMany = vi.fn(() => new Promise((resolve) => setImmediate(() => resolve(batch(0, EXPORT_BATCH_SIZE)))));
    const { service, response } = setUp(findMany);

    const done = service.writeCsv('user-1', response as never);
    await settle();
    response.emit('close');
    const queriesAtClose = findMany.mock.calls.length;
    await done;

    // At most the query already running when the client left.
    expect(findMany.mock.calls.length).toBeLessThanOrEqual(queriesAtClose + 1);
    expect(response.end).not.toHaveBeenCalled();
  });

  it('finishes when the client goes away while a batch is being read', async () => {
    const findMany = vi.fn();
    const { service, response } = setUp(findMany);
    findMany.mockImplementation(() => {
      response.goAway();
      return Promise.resolve(batch(0, EXPORT_BATCH_SIZE));
    });

    const outcome = await Promise.race([
      service.writeCsv('user-1', response as never).then(() => 'finished'),
      new Promise((resolve) => setTimeout(() => resolve('still waiting'), 200)),
    ]);

    expect(outcome).toBe('finished');
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(response.end).not.toHaveBeenCalled();
  });

  it('finishes at once for a client that left before the export started', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const { service, response } = setUp(findMany);
    response.goAway();

    const outcome = await Promise.race([
      service.writeCsv('user-1', response as never).then(() => 'finished'),
      new Promise((resolve) => setTimeout(() => resolve('still waiting'), 200)),
    ]);

    expect(outcome).toBe('finished');
    expect(findMany).not.toHaveBeenCalled();
  });

  it('cuts the connection when the database fails mid-file, so it does not look complete', async () => {
    const failure = new Error('connection terminated');
    const findMany = vi.fn().mockResolvedValueOnce(batch(0, EXPORT_BATCH_SIZE)).mockRejectedValueOnce(failure);
    const { service, response } = setUp(findMany);

    await service.writeCsv('user-1', response as never);

    expect(response.destroy).toHaveBeenCalledWith(failure);
    expect(response.end).not.toHaveBeenCalled();
  });
});
