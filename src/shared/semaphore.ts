// Limits how many callers hold a permit at once; the rest wait in arrival order.
// The worker uses it to cap provider calls (the case: at most 4 per worker).
export class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(permits: number) {
    this.available = permits;
  }

  // Resolves with a release function. Rejects with the signal's reason if it
  // aborts while waiting, without taking a permit.
  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      return Promise.reject(signal.reason);
    }
    if (this.available > 0) {
      this.available -= 1;
      return Promise.resolve(this.releaser());
    }
    return new Promise((resolve, reject) => {
      const grant = (): void => {
        signal?.removeEventListener('abort', onAbort);
        resolve(this.releaser());
      };
      const onAbort = (): void => {
        this.waiters.splice(this.waiters.indexOf(grant), 1);
        reject(signal?.reason);
      };
      this.waiters.push(grant);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  // Each release function works once, so a double release cannot add a permit.
  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const next = this.waiters.shift();
      if (next) {
        next();
      } else {
        this.available += 1;
      }
    };
  }
}
