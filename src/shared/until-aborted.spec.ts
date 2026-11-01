import { untilAborted } from './until-aborted.ts';

describe('untilAborted', () => {
  it('settles like the promise when it settles first', async () => {
    const controller = new AbortController();

    await expect(untilAborted(Promise.resolve('answer'), controller.signal)).resolves.toBe('answer');
    await expect(untilAborted(Promise.reject(new Error('refused')), controller.signal)).rejects.toThrow('refused');
  });

  it('rejects with the abort reason when the signal fires first, even if the promise never settles', async () => {
    const controller = new AbortController();
    const never = new Promise<string>(() => undefined);

    const waiting = untilAborted(never, controller.signal);
    controller.abort(new Error('timed out'));

    await expect(waiting).rejects.toThrow('timed out');
  });

  it('rejects at once for a signal that has already fired', async () => {
    await expect(untilAborted(Promise.resolve('late'), AbortSignal.abort(new Error('gone')))).rejects.toThrow('gone');
  });
});
