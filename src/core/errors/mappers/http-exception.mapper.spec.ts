import { BadRequestException, HttpException, HttpStatus, InternalServerErrorException } from '@nestjs/common';
import { CommonErrorCode } from '../error-codes.ts';
import { HttpExceptionMapper } from './http-exception.mapper.ts';

describe('HttpExceptionMapper', () => {
  const mapper = new HttpExceptionMapper();

  it('reports a malformed JSON body as INVALID_JSON', () => {
    const exception = new BadRequestException(`Expected property name or '}' in JSON at position 1`);

    expect(mapper.map(exception)).toEqual(
      expect.objectContaining({ status: HttpStatus.BAD_REQUEST, code: CommonErrorCode.INVALID_JSON }),
    );
  });

  it.each([
    [HttpStatus.BAD_REQUEST, 'BAD_REQUEST'],
    [HttpStatus.NOT_FOUND, CommonErrorCode.NOT_FOUND],
    [HttpStatus.METHOD_NOT_ALLOWED, 'METHOD_NOT_ALLOWED'],
    [HttpStatus.PAYLOAD_TOO_LARGE, CommonErrorCode.PAYLOAD_TOO_LARGE],
    [HttpStatus.UNSUPPORTED_MEDIA_TYPE, 'UNSUPPORTED_MEDIA_TYPE'],
    [HttpStatus.TOO_MANY_REQUESTS, CommonErrorCode.TOO_MANY_REQUESTS],
  ])('derives the code of status %i from its HTTP status text', (status, code) => {
    expect(mapper.map(new HttpException('Rejected', status)).code).toBe(code);
  });

  it('leaves 5xx exceptions to the unexpected-error path (ERR-05)', () => {
    expect(mapper.canMap(new InternalServerErrorException())).toBe(false);
    expect(mapper.canMap(new BadRequestException())).toBe(true);
  });
});
