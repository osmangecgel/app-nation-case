import type { AiProvider, AiRequest, AiResult } from '#infra/ai-provider/ai-provider.ts';

type Waiting = { resolve: (result: AiResult) => void; reject: (error: Error) => void };

const POLL_INTERVAL_MS = 5;
const WAIT_LIMIT_MS = 5_000;

// A provider the test answers by hand: calls wait until respond() or fail(),
// so tests decide what happens and when, without real delays.
export class ControllableAiProvider implements AiProvider {
  readonly adapter = 'fake';
  readonly calls: AiRequest[] = [];
  private waiting: Waiting[] = [];

  generate(request: AiRequest, signal: AbortSignal): Promise<AiResult> {
    this.calls.push(request);
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject };
      this.waiting.push(entry);
      signal.addEventListener(
        'abort',
        () => {
          this.waiting = this.waiting.filter((other) => other !== entry);
          reject(signal.reason);
        },
        { once: true },
      );
    });
  }

  // Answers every call waiting now with `Özet: <input>` (or the given text).
  respond(text?: string): void {
    const waiting = this.waiting;
    this.waiting = [];
    waiting.forEach((entry, index) => entry.resolve({ text: text ?? `Özet: ${this.calls[index]?.input ?? ''}` }));
  }

  fail(error: Error): void {
    const waiting = this.waiting;
    this.waiting = [];
    waiting.forEach((entry) => entry.reject(error));
  }

  get pending(): number {
    return this.waiting.length;
  }

  reset(): void {
    this.calls.length = 0;
    this.waiting = [];
  }
}

// Polls until the condition holds; fails the test after a few seconds.
export async function waitFor(condition: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + WAIT_LIMIT_MS;
  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error('Condition not met in time.');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}
