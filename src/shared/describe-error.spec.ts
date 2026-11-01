import { describeError } from './describe-error.ts';

describe('describeError', () => {
  it('uses the code when the message is empty, as with a refused localhost connection', () => {
    const error = Object.assign(new AggregateError([], ''), { code: 'ECONNREFUSED' });

    expect(describeError(error)).toBe('ECONNREFUSED');
  });

  it('joins the code and the message when both exist', () => {
    const error = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });

    expect(describeError(error)).toBe('ECONNRESET: read ECONNRESET');
  });

  it('falls back to the error name, and to the value itself for non-errors', () => {
    expect(describeError(new TypeError(''))).toBe('TypeError');
    expect(describeError('NOSCRIPT')).toBe('NOSCRIPT');
  });
});
