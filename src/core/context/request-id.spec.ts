import { generateRequestId, requestIdFromTraceparent } from './request-id.ts';

describe('requestIdFromTraceparent', () => {
  it('returns the request id of a valid W3C traceparent header as the request id', () => {
    const header = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

    expect(requestIdFromTraceparent(header)).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
  });

  it.each([
    ['a missing header', undefined],
    ['a malformed header', 'not-a-traceparent'],
    ['an all-zero request id', '00-00000000000000000000000000000000-00f067aa0ba902b7-01'],
    ['upper-case hex', '00-4BF92F3577B34DA6A3CE929D0E0E4736-00f067aa0ba902b7-01'],
  ])('returns undefined for %s', (_case, header) => {
    expect(requestIdFromTraceparent(header)).toBeUndefined();
  });
});

describe('generateRequestId', () => {
  it('returns 32 lower-case hex characters', () => {
    expect(generateRequestId()).toMatch(/^[0-9a-f]{32}$/);
  });
});
