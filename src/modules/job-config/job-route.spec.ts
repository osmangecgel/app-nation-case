import { type JobRoute, pickRoute } from './job-route.ts';

const MAIN: JobRoute = { providerCode: 'anthropic', modelVersion: 'claude-x', weight: 90 };
const TRIAL: JobRoute = { providerCode: 'openai', modelVersion: 'gpt-y', weight: 10 };

describe('pickRoute', () => {
  it('returns the only route', () => {
    expect(pickRoute([MAIN], 0.99)).toBe(MAIN);
  });

  it.each([
    [0, MAIN],
    [0.89, MAIN],
    [0.9, TRIAL],
    [0.999, TRIAL],
  ])('splits traffic by weight (random %s)', (random, expected) => {
    expect(pickRoute([MAIN, TRIAL], random)).toBe(expected);
  });
});
