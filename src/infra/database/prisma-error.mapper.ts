import { HttpStatus } from '@nestjs/common';
import { z } from 'zod';
import type { FieldError } from '#core/errors/app-errors.ts';
import { CommonErrorCode, FieldErrorCode } from '#core/errors/error-codes.ts';
import type { ProblemFields, ProblemMapper } from '#core/errors/problem-mapper.ts';
import { Prisma } from '#generated/prisma/client.ts';
import { PrismaErrorCode } from './prisma-errors.ts';

const KNOWN_CODES = new Set<string>([
  PrismaErrorCode.UNIQUE_VIOLATION,
  PrismaErrorCode.RECORD_NOT_FOUND,
  PrismaErrorCode.TRANSACTION_CONFLICT,
]);

// Prisma 7 driver adapters report the columns under driverAdapterError, not
// under the `target` key older Prisma versions used.
const AdapterUniqueViolation = z.object({
  driverAdapterError: z.object({ cause: z.object({ constraint: z.object({ fields: z.array(z.string()) }) }) }),
});

function conflictingFields(error: Prisma.PrismaClientKnownRequestError): FieldError[] {
  const parsed = AdapterUniqueViolation.safeParse(error.meta);
  const fields = parsed.success ? parsed.data.driverAdapterError.cause.constraint.fields : [];
  return fields.map((field) => ({ field, code: FieldErrorCode.ALREADY_EXISTS, message: 'Value already exists.' }));
}

// ERR-06: Prisma errors that are the client's doing become 404/409 instead of 500.
export class PrismaErrorMapper implements ProblemMapper {
  canMap(exception: unknown): exception is Prisma.PrismaClientKnownRequestError {
    return exception instanceof Prisma.PrismaClientKnownRequestError && KNOWN_CODES.has(exception.code);
  }

  map(exception: Prisma.PrismaClientKnownRequestError): ProblemFields {
    if (exception.code === PrismaErrorCode.UNIQUE_VIOLATION) {
      return {
        status: HttpStatus.CONFLICT,
        code: CommonErrorCode.CONFLICT,
        detail: 'A record with the same values already exists.',
        errors: conflictingFields(exception),
      };
    }
    if (exception.code === PrismaErrorCode.RECORD_NOT_FOUND) {
      return { status: HttpStatus.NOT_FOUND, code: CommonErrorCode.NOT_FOUND, detail: 'Record was not found.' };
    }
    return {
      status: HttpStatus.CONFLICT,
      code: CommonErrorCode.CONFLICT,
      detail: 'The request conflicted with a concurrent change. Try again.',
    };
  }
}
