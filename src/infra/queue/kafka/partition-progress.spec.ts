import { PartitionProgress } from './partition-progress.ts';

describe('PartitionProgress', () => {
  it('commits past a message once it finishes and nothing older runs', () => {
    const progress = new PartitionProgress(10);
    progress.start(4n);

    expect(progress.finish(4n)).toBe(5n);
  });

  it('holds the commit at the oldest running message while newer ones finish', () => {
    const progress = new PartitionProgress(10);
    for (const offset of [4n, 5n, 6n]) {
      progress.start(offset);
    }

    expect(progress.finish(5n)).toBeNull();
    expect(progress.finish(6n)).toBeNull();
    expect(progress.finish(4n)).toBe(7n);
  });

  it('moves the commit only as far as the next running message', () => {
    const progress = new PartitionProgress(10);
    for (const offset of [4n, 5n, 6n]) {
      progress.start(offset);
    }

    expect(progress.finish(4n)).toBe(5n);
    expect(progress.finish(6n)).toBeNull();
    expect(progress.finish(5n)).toBe(7n);
  });

  it('counts started messages that are not committed yet', () => {
    const progress = new PartitionProgress(10);
    for (const offset of [4n, 5n, 6n]) {
      progress.start(offset);
    }
    progress.finish(5n);

    expect(progress.uncommitted()).toBe(3);
    progress.finish(4n);
    expect(progress.uncommitted()).toBe(1);
  });

  it('makes a new message wait while too many are uncommitted', async () => {
    const progress = new PartitionProgress(2);
    progress.start(4n);
    progress.start(5n);
    progress.finish(5n);

    let admitted = false;
    const waiting = progress.waitForRoom(new AbortController().signal).then(() => {
      admitted = true;
    });
    await Promise.resolve();
    expect(admitted).toBe(false);

    progress.finish(4n);
    await waiting;
    expect(admitted).toBe(true);
  });

  it('stops waiting when the signal aborts', async () => {
    const progress = new PartitionProgress(1);
    progress.start(4n);
    const controller = new AbortController();

    const waiting = progress.waitForRoom(controller.signal);
    controller.abort(new Error('stopping'));

    await expect(waiting).rejects.toThrow('stopping');
  });

  it('never commits for a revoked partition and lets its waiters go', async () => {
    const progress = new PartitionProgress(1);
    progress.start(4n);
    const waiting = progress.waitForRoom(new AbortController().signal);

    progress.revoke();

    await expect(waiting).resolves.toBeUndefined();
    expect(progress.finish(4n)).toBeNull();
  });
});
