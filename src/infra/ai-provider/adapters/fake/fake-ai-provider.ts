import { sleep } from '#shared/sleep.ts';
import {
  type AiProvider,
  type AiRequest,
  type AiResult,
  PermanentAiError,
  TransientAiError,
} from '#infra/ai-provider/ai-provider.ts';

export const FAKE_ADAPTER = 'fake';

const NORMAL_DELAY_MS = 500;
const SLOW_DELAY_MS = 5_000;
const FLAKY_FAILURES = 2;
// Bounds the memory of flaky call counts; the oldest inputs are forgotten first.
const FLAKY_MEMORY_LIMIT = 10_000;

const RESULT_PREFIX: Record<string, string> = {
  summary: 'Özet: ',
  translate: 'Çeviri: ',
};

// Never settles until the signal aborts, then rejects with its reason.
function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

// The provider the case describes, chosen by how the (normalised) input starts:
//   slow  → answers after ~5 s
//   flaky → transient error on the first 2 calls for the same input, then answers
//   fail  → permanent error
//   hang  → never answers; stops only when the signal aborts
//   other → answers after ~500 ms
// Every wait is a timer, never a busy loop, so the event loop stays free.
export class FakeAiProvider implements AiProvider {
  readonly adapter = FAKE_ADAPTER;
  private readonly flakyCalls = new Map<string, number>();

  async generate(request: AiRequest, signal: AbortSignal): Promise<AiResult> {
    const prefix = RESULT_PREFIX[request.jobType];
    if (!prefix) {
      throw new PermanentAiError(`Unsupported job type ${request.jobType}.`);
    }
    const { input } = request;
    if (input.startsWith('fail')) {
      throw new PermanentAiError('Input rejected.');
    }
    if (input.startsWith('hang')) {
      return waitForAbort(signal);
    }
    if (input.startsWith('flaky') && this.countFlakyCall(input) <= FLAKY_FAILURES) {
      await sleep(NORMAL_DELAY_MS, signal);
      throw new TransientAiError('Temporarily unavailable.');
    }
    await sleep(input.startsWith('slow') ? SLOW_DELAY_MS : NORMAL_DELAY_MS, signal);
    return { text: `${prefix}${input}` };
  }

  // Returns the number of this call for the input (1 for the first).
  private countFlakyCall(input: string): number {
    const calls = (this.flakyCalls.get(input) ?? 0) + 1;
    this.flakyCalls.delete(input);
    this.flakyCalls.set(input, calls);
    if (this.flakyCalls.size > FLAKY_MEMORY_LIMIT) {
      const oldest = this.flakyCalls.keys().next().value;
      if (oldest !== undefined) {
        this.flakyCalls.delete(oldest);
      }
    }
    return calls;
  }
}
