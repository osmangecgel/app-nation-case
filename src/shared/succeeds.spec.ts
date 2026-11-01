import { succeeds } from './succeeds.ts';

describe('succeeds', () => {
  it('returns true when the operation completes', async () => {
    await expect(succeeds(async () => undefined)).resolves.toBe(true);
  });

  it('returns false instead of throwing when the operation fails', async () => {
    await expect(succeeds(() => Promise.reject(new Error('down')))).resolves.toBe(false);
  });
});
