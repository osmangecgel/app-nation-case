import { HttpStatus } from '@nestjs/common';
import type { FieldErrorCode } from './error-codes.ts';

export type FieldError = {
  field: string;
  code: FieldErrorCode;
  message: string;
};

// Services throw these instead of NestJS HttpException (ERR-03), so the same
// service reports meaningful errors when called from a queue handler.
export abstract class AppError extends Error {
  abstract readonly status: HttpStatus;

  constructor(
    readonly code: string,
    readonly detail: string,
    readonly errors: FieldError[] = [],
  ) {
    super(detail);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  readonly status = HttpStatus.BAD_REQUEST;
}

export class UnauthorizedError extends AppError {
  readonly status = HttpStatus.UNAUTHORIZED;
}

export class NotFoundError extends AppError {
  readonly status = HttpStatus.NOT_FOUND;
}

export class PaymentRequiredError extends AppError {
  readonly status = HttpStatus.PAYMENT_REQUIRED;
}

export class ConflictError extends AppError {
  readonly status = HttpStatus.CONFLICT;
}

export class BusinessRuleError extends AppError {
  readonly status = HttpStatus.UNPROCESSABLE_ENTITY;
}

export class TooManyRequestsError extends AppError {
  readonly status = HttpStatus.TOO_MANY_REQUESTS;

  // Sent as Retry-After, so a client knows when trying again makes sense.
  constructor(
    code: string,
    detail: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(code, detail);
  }
}
