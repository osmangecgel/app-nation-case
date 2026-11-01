import { STATUS_CODES } from 'node:http';

// General error codes (ERR-02). Module-specific codes live in <module>.errors.ts.
export const CommonErrorCode = {
  INVALID_JSON: 'INVALID_JSON',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  TOO_MANY_REQUESTS: 'TOO_MANY_REQUESTS',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;
export type CommonErrorCode = (typeof CommonErrorCode)[keyof typeof CommonErrorCode];

// Field-level codes in the `errors` list (ERR-04).
export const FieldErrorCode = {
  REQUIRED: 'REQUIRED',
  INVALID_TYPE: 'INVALID_TYPE',
  INVALID_FORMAT: 'INVALID_FORMAT',
  INVALID_VALUE: 'INVALID_VALUE',
  TOO_SMALL: 'TOO_SMALL',
  TOO_BIG: 'TOO_BIG',
  UNKNOWN_FIELD: 'UNKNOWN_FIELD',
  ALREADY_EXISTS: 'ALREADY_EXISTS',
} as const;
export type FieldErrorCode = (typeof FieldErrorCode)[keyof typeof FieldErrorCode];

// Code for errors raised by NestJS or Express themselves (ERR-02): the HTTP
// status text, e.g. 405 -> METHOD_NOT_ALLOWED, 413 -> PAYLOAD_TOO_LARGE.
export function codeFromHttpStatus(status: number): string {
  return (STATUS_CODES[status] ?? CommonErrorCode.INTERNAL_ERROR).toUpperCase().replace(/\W+/g, '_');
}
