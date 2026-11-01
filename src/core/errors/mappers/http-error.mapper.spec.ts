import { HttpStatus } from '@nestjs/common';
import { CommonErrorCode } from '../error-codes.ts';
import { HttpErrorMapper } from './http-error.mapper.ts';

// Shaped like the errors Express and body-parser throw (the http-errors package).
function httpError(
  status: number,
  expose: boolean,
  message = 'request entity too large',
): Error & { status: number; expose: boolean } {
  return Object.assign(new Error(message), { status, statusCode: status, expose });
}

describe('HttpErrorMapper', () => {
  const mapper = new HttpErrorMapper();

  it('maps an oversized body to 413 PAYLOAD_TOO_LARGE', () => {
    const error = httpError(HttpStatus.PAYLOAD_TOO_LARGE, true);

    expect(mapper.canMap(error)).toBe(true);
    expect(mapper.map(error)).toEqual({
      status: HttpStatus.PAYLOAD_TOO_LARGE,
      code: CommonErrorCode.PAYLOAD_TOO_LARGE,
      detail: 'request entity too large',
    });
  });

  it('leaves errors that are not safe to show to the unexpected-error path', () => {
    expect(mapper.canMap(httpError(HttpStatus.BAD_REQUEST, false))).toBe(false);
    expect(mapper.canMap(httpError(HttpStatus.INTERNAL_SERVER_ERROR, true))).toBe(false);
    expect(mapper.canMap(new Error('plain'))).toBe(false);
  });
});
