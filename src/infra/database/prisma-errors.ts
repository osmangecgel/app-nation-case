import { Prisma } from '#generated/prisma/client.ts';

export const PrismaErrorCode = {
  UNIQUE_VIOLATION: 'P2002',
  FOREIGN_KEY_VIOLATION: 'P2003',
  RECORD_NOT_FOUND: 'P2025',
  TRANSACTION_CONFLICT: 'P2034',
} as const;
export type PrismaErrorCode = (typeof PrismaErrorCode)[keyof typeof PrismaErrorCode];

// Lets a service give a Prisma error its own meaning, e.g. a foreign key
// violation on delete means "the record still has children".
export function isPrismaError(error: unknown, code: PrismaErrorCode): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
}
