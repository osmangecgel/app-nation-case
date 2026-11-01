import { HttpStatus } from '@nestjs/common';
import {
  type AppError,
  BusinessRuleError,
  ConflictError,
  NotFoundError,
  PaymentRequiredError,
  TooManyRequestsError,
  UnauthorizedError,
  ValidationError,
} from './app-errors.ts';

describe('AppError classes (ERR-03)', () => {
  it.each<[string, AppError, HttpStatus]>([
    ['ValidationError', new ValidationError('CODE', 'Detail.'), HttpStatus.BAD_REQUEST],
    ['UnauthorizedError', new UnauthorizedError('CODE', 'Detail.'), HttpStatus.UNAUTHORIZED],
    ['NotFoundError', new NotFoundError('CODE', 'Detail.'), HttpStatus.NOT_FOUND],
    ['PaymentRequiredError', new PaymentRequiredError('CODE', 'Detail.'), HttpStatus.PAYMENT_REQUIRED],
    ['ConflictError', new ConflictError('CODE', 'Detail.'), HttpStatus.CONFLICT],
    ['BusinessRuleError', new BusinessRuleError('CODE', 'Detail.'), HttpStatus.UNPROCESSABLE_ENTITY],
    ['TooManyRequestsError', new TooManyRequestsError('CODE', 'Detail.'), HttpStatus.TOO_MANY_REQUESTS],
  ])('%s carries its HTTP status, code, detail and name', (name, error, status) => {
    expect(error.status).toBe(status);
    expect(error).toEqual(
      expect.objectContaining({ code: 'CODE', detail: 'Detail.', message: 'Detail.', name, errors: [] }),
    );
  });
});
