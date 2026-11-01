import { Logger } from '@nestjs/common';
import { TooManyRequestsError } from '#core/errors/app-errors.ts';
import { ExportAdmissionService } from './export-admission.service.ts';

const WAIT_MS = 1_000;

// The cache Redis as far as admission uses it: user locks and a shared pool of
// permits. `down` makes every call report Redis as unavailable (null).
class FakeCache {
  down = false;
  readonly locks = new Map<string, string>();
  readonly permits = new Set<string>();

  constructor(private readonly limit: number) {}

  acquireLock(_domain: string, id: string, token: string): Promise<boolean | null> {
    if (this.down) {
      return Promise.resolve(null);
    }
    if (this.locks.has(id)) {
      return Promise.resolve(false);
    }
    this.locks.set(id, token);
    return Promise.resolve(true);
  }

  extendLock(): Promise<boolean | null> {
    return Promise.resolve(this.down ? null : true);
  }

  releaseLock(_domain: string, id: string, token: string): Promise<void> {
    if (this.locks.get(id) === token) {
      this.locks.delete(id);
    }
    return Promise.resolve();
  }

  acquirePermit(_domain: string, _id: string, holder: string): Promise<boolean | null> {
    if (this.down) {
      return Promise.resolve(null);
    }
    if (this.permits.size >= this.limit) {
      return Promise.resolve(false);
    }
    this.permits.add(holder);
    return Promise.resolve(true);
  }

  renewPermit(): Promise<boolean | null> {
    return Promise.resolve(this.down ? null : true);
  }

  releasePermit(_domain: string, _id: string, holder: string): Promise<void> {
    this.permits.delete(holder);
    return Promise.resolve();
  }
}

function setUp(limit = 1, fallbackLimit = 1): { admission: ExportAdmissionService; cache: FakeCache } {
  const cache = new FakeCache(limit);
  const settings: Record<string, number> = {
    EXPORT_MAX_CONCURRENT: limit,
    EXPORT_FALLBACK_MAX_CONCURRENT: fallbackLimit,
    EXPORT_ADMISSION_WAIT_MS: WAIT_MS,
  };
  const config = { get: (key: string) => settings[key] };
  return { admission: new ExportAdmissionService(cache as never, config as never), cache };
}

describe('ExportAdmissionService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('admits an export and frees its slot and lock when it ends', async () => {
    const { admission, cache } = setUp();

    const pass = await admission.admit('user-1', new AbortController().signal);
    expect(cache.permits.size).toBe(1);
    expect(cache.locks.has('user-1')).toBe(true);

    await pass.release();
    expect(cache.permits.size).toBe(0);
    expect(cache.locks.size).toBe(0);
  });

  it('refuses a second export of the same user at once, with Retry-After', async () => {
    const { admission } = setUp(5);
    await admission.admit('user-1', new AbortController().signal);

    const second = admission.admit('user-1', new AbortController().signal);

    await expect(second).rejects.toBeInstanceOf(TooManyRequestsError);
    await expect(second).rejects.toMatchObject({ code: 'EXPORT_IN_PROGRESS', retryAfterSeconds: 10 });
  });

  it('waits for a slot and takes it when one frees in time', async () => {
    const { admission } = setUp(1);
    const first = await admission.admit('user-1', new AbortController().signal);

    const second = admission.admit('user-2', new AbortController().signal);
    await vi.advanceTimersByTimeAsync(300);
    await first.release();
    await vi.advanceTimersByTimeAsync(600);

    await expect(second).resolves.toBeDefined();
  });

  it('answers 429 when no slot frees within the wait, and gives the user lock back', async () => {
    const { admission, cache } = setUp(1);
    await admission.admit('user-1', new AbortController().signal);

    const second = admission.admit('user-2', new AbortController().signal);
    const outcome = expect(second).rejects.toMatchObject({ code: 'EXPORT_SLOTS_BUSY', retryAfterSeconds: 10 });
    await vi.advanceTimersByTimeAsync(WAIT_MS + 600);
    await outcome;

    expect(cache.locks.has('user-2')).toBe(false);
  });

  it('stops waiting as soon as the client goes away, and gives the user lock back', async () => {
    const { admission, cache } = setUp(1);
    await admission.admit('user-1', new AbortController().signal);
    const client = new AbortController();

    const second = admission.admit('user-2', client.signal);
    const outcome = expect(second).rejects.toThrow('client left');
    client.abort(new Error('client left'));
    await outcome;

    expect(cache.locks.has('user-2')).toBe(false);
  });

  it('keeps a per-instance limit while Redis is unavailable, instead of none', async () => {
    const { admission, cache } = setUp(5, 1);
    cache.down = true;
    const first = await admission.admit('user-1', new AbortController().signal);

    const second = admission.admit('user-2', new AbortController().signal);
    const outcome = expect(second).rejects.toMatchObject({ code: 'EXPORT_SLOTS_BUSY' });
    await vi.advanceTimersByTimeAsync(WAIT_MS + 10);
    await outcome;

    await first.release();
    await expect(admission.admit('user-3', new AbortController().signal)).resolves.toBeDefined();
  });
});
