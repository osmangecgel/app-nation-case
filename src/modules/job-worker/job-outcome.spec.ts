import { retryDelayMs } from './job-outcome.ts';

describe('retryDelayMs', () => {
  it.each([
    [1, 1_000],
    [2, 2_000],
    [3, 4_000],
  ])('doubles the delay after attempt %i', (attemptCount, expected) => {
    expect(retryDelayMs(attemptCount, 1_000, 250, 0)).toBe(expected);
  });

  it('adds up to the jitter at random', () => {
    expect(retryDelayMs(1, 1_000, 250, 0.999)).toBe(1_249);
  });
});
