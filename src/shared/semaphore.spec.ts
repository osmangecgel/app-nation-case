import { Semaphore } from './semaphore.ts';

describe('Semaphore', () => {
  it('lets up to the permit count in at once', async () => {
    const semaphore = new Semaphore(2);
    await semaphore.acquire();
    await semaphore.acquire();
    let third = false;

    void semaphore.acquire().then(() => {
      third = true;
    });
    await Promise.resolve();

    expect(third).toBe(false);
  });

  it('hands a released permit to the first waiter', async () => {
    const semaphore = new Semaphore(1);
    const release = await semaphore.acquire();
    const order: string[] = [];
    const first = semaphore.acquire().then(() => order.push('first'));
    const second = semaphore.acquire().then(() => order.push('second'));

    release();
    await first;

    expect(order).toEqual(['first']);
    void second;
  });

  it('ignores a second release of the same permit', async () => {
    const semaphore = new Semaphore(1);
    const release = await semaphore.acquire();
    release();
    release();

    await semaphore.acquire();
    let extra = false;
    void semaphore.acquire().then(() => {
      extra = true;
    });
    await Promise.resolve();

    expect(extra).toBe(false);
  });

  it('stops waiting when the signal aborts', async () => {
    const semaphore = new Semaphore(1);
    await semaphore.acquire();
    const controller = new AbortController();
    const waiting = semaphore.acquire(controller.signal);

    controller.abort(new Error('shutdown'));

    await expect(waiting).rejects.toThrow('shutdown');
  });
});
