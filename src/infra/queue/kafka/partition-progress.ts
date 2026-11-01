// Tracks one partition's messages while they are handled side by side.
//
// Kafka keeps one number per partition: "every message before this offset is
// done". With several messages in flight, that number may only move up to the
// oldest message still running; newer ones that finished first wait for it.
// Messages are started in offset order, so the oldest running one is the
// first in the set (a Set keeps insertion order).
export class PartitionProgress {
  private readonly running = new Set<bigint>();
  private readonly roomWaiters = new Set<() => void>();
  // The offset Kafka would deliver next if the worker restarted now.
  private committed: bigint | null = null;
  // The offset after the last started message.
  private next: bigint | null = null;
  private isRevoked = false;

  // At most this many messages between the committed offset and the newest
  // started one: the messages a crash would deliver again.
  constructor(private readonly maxUncommitted: number) {}

  get revoked(): boolean {
    return this.isRevoked;
  }

  start(offset: bigint): void {
    this.committed ??= offset;
    this.running.add(offset);
    this.next = offset + 1n;
  }

  // The offset to commit when it moved forward, otherwise null.
  finish(offset: bigint): bigint | null {
    this.running.delete(offset);
    const oldestRunning = this.running.values().next();
    const commitTo = oldestRunning.done ? this.next : oldestRunning.value;
    if (this.isRevoked || commitTo === null || this.committed === null || commitTo <= this.committed) {
      return null;
    }
    this.committed = commitTo;
    this.wakeWaiters();
    return commitTo;
  }

  uncommitted(): number {
    return this.next === null || this.committed === null ? 0 : Number(this.next - this.committed);
  }

  // Resolves once another message may start; rejects when the signal aborts.
  waitForRoom(signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      return Promise.reject(signal.reason);
    }
    if (this.hasRoom()) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        this.roomWaiters.delete(admit);
        reject(signal.reason);
      };
      const admit = (): void => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      };
      this.roomWaiters.add(admit);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  // The partition moved to another consumer: its offsets are no longer ours
  // to commit. Messages still running finish, but commit nothing.
  revoke(): void {
    this.isRevoked = true;
    this.wakeWaiters();
  }

  private hasRoom(): boolean {
    return this.isRevoked || this.uncommitted() < this.maxUncommitted;
  }

  private wakeWaiters(): void {
    for (const admit of this.roomWaiters) {
      if (!this.hasRoom()) {
        return;
      }
      this.roomWaiters.delete(admit);
      admit();
    }
  }
}
