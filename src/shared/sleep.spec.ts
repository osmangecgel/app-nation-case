import { sleep } from './sleep.ts';

describe('sleep', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves after the given time', async () => {
    const pending = sleep(1_000);

    await vi.advanceTimersByTimeAsync(1_000);

    await expect(pending).resolves.toBeUndefined();
  });

  it('rejects with the reason when the signal aborts', async () => {
    const controller = new AbortController();
    const pending = sleep(1_000, controller.signal);

    controller.abort(new Error('stop'));

    await expect(pending).rejects.toThrow('stop');
  });

  it('rejects at once when the signal is already aborted', async () => {
    await expect(sleep(1_000, AbortSignal.abort(new Error('stop')))).rejects.toThrow('stop');
  });
});
