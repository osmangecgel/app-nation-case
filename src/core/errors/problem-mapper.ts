import type { HttpStatus } from '@nestjs/common';
import type { FieldError } from './app-errors.ts';

// The parts of an RFC 9457 response that depend on the error itself (ERR-01).
export type ProblemFields = {
  status: HttpStatus;
  code: string;
  detail: string;
  errors?: FieldError[];
};

// Turns one kind of thrown error into ProblemFields. Each kind of error has
// its own mapper (CODE-18); ProblemDetailsFilter uses the first that matches.
export interface ProblemMapper {
  canMap(exception: unknown): boolean;
  map(exception: unknown): ProblemFields;
}

export const PROBLEM_MAPPERS = Symbol('PROBLEM_MAPPERS');
