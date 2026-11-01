import { PermanentAiError, TransientAiError } from '#infra/ai-provider/ai-provider.ts';
import { FakeAiProvider } from './fake-ai-provider.ts';

const request = (input: string, jobType = 'summary') => ({ jobType, input, modelVersion: 'fake-v1' });

describe('FakeAiProvider', () => {
  let provider: FakeAiProvider;

  beforeEach(() => {
    vi.useFakeTimers();
    provider = new FakeAiProvider();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function settle<T>(promise: Promise<T>, ms: number): Promise<T> {
    // Marks a rejection as handled while the timers run; the caller still sees it.
    promise.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(ms);
    return promise;
  }

  it.each([
    ['summary', 'Özet: merhaba'],
    ['translate', 'Çeviri: merhaba'],
  ])('answers a %s after about 500 ms', async (jobType, text) => {
    await expect(
      settle(provider.generate(request('merhaba', jobType), new AbortController().signal), 500),
    ).resolves.toEqual({
      text,
    });
  });

  it('answers slow input after about 5 seconds', async () => {
    const pending = provider.generate(request('slow deneme'), new AbortController().signal);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(4_900);
    expect(settled).toBe(false);
    await expect(settle(pending, 100)).resolves.toEqual({ text: 'Özet: slow deneme' });
  });

  it('fails flaky input twice with a transient error, then answers', async () => {
    const signal = new AbortController().signal;

    await expect(settle(provider.generate(request('flaky deneme'), signal), 500)).rejects.toThrow(TransientAiError);
    await expect(settle(provider.generate(request('flaky deneme'), signal), 500)).rejects.toThrow(TransientAiError);
    await expect(settle(provider.generate(request('flaky deneme'), signal), 500)).resolves.toEqual({
      text: 'Özet: flaky deneme',
    });
  });

  it('rejects fail input with a permanent error', async () => {
    await expect(provider.generate(request('fail deneme'), new AbortController().signal)).rejects.toThrow(
      PermanentAiError,
    );
  });

  it('never answers hang input until the signal aborts', async () => {
    const controller = new AbortController();
    const pending = provider.generate(request('hang deneme'), controller.signal);

    await vi.advanceTimersByTimeAsync(60_000);
    controller.abort(new Error('timed out'));

    await expect(pending).rejects.toThrow('timed out');
  });

  it('stops waiting when the signal aborts', async () => {
    const controller = new AbortController();
    const pending = provider.generate(request('slow deneme'), controller.signal);

    controller.abort(new Error('shutdown'));

    await expect(pending).rejects.toThrow();
  });

  it('rejects an unsupported job type with a permanent error', async () => {
    await expect(provider.generate(request('merhaba', 'image'), new AbortController().signal)).rejects.toThrow(
      PermanentAiError,
    );
  });
});
