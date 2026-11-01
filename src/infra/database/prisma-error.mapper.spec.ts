import { HttpStatus } from '@nestjs/common';
import { CommonErrorCode, FieldErrorCode } from '#core/errors/error-codes.ts';
import { Prisma } from '#generated/prisma/client.ts';
import { PrismaErrorMapper } from './prisma-error.mapper.ts';

type PrismaMeta = Record<string, string[] | string | object>;

// The shape Prisma 7 driver adapters give P2002 (see @prisma/driver-adapter-utils).
const ADAPTER_UNIQUE_META = {
  modelName: 'User',
  driverAdapterError: { cause: { kind: 'UniqueConstraintViolation', constraint: { fields: ['email'] } } },
};

function prismaError(code: string, meta?: PrismaMeta): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Prisma error', { code, clientVersion: '7.10.1', meta });
}

describe('PrismaErrorMapper', () => {
  const mapper = new PrismaErrorMapper();

  it('maps a unique constraint violation (P2002) to 409 with the conflicting fields', () => {
    expect(mapper.map(prismaError('P2002', ADAPTER_UNIQUE_META))).toEqual({
      status: HttpStatus.CONFLICT,
      code: CommonErrorCode.CONFLICT,
      detail: 'A record with the same values already exists.',
      errors: [{ field: 'email', code: FieldErrorCode.ALREADY_EXISTS, message: 'Value already exists.' }],
    });
  });

  it('returns no field errors when only the index name is known', () => {
    const meta = {
      driverAdapterError: { cause: { kind: 'UniqueConstraintViolation', constraint: { index: 'users_email_key' } } },
    };

    expect(mapper.map(prismaError('P2002', meta)).errors).toEqual([]);
  });

  it('maps a missing record (P2025) to 404', () => {
    expect(mapper.map(prismaError('P2025'))).toEqual(
      expect.objectContaining({ status: HttpStatus.NOT_FOUND, code: CommonErrorCode.NOT_FOUND }),
    );
  });

  it('maps a transaction conflict (P2034) to 409', () => {
    expect(mapper.map(prismaError('P2034'))).toEqual(
      expect.objectContaining({ status: HttpStatus.CONFLICT, code: CommonErrorCode.CONFLICT }),
    );
  });

  it('only handles the Prisma codes it knows', () => {
    expect(mapper.canMap(prismaError('P2002'))).toBe(true);
    expect(mapper.canMap(prismaError('P1001'))).toBe(false);
    expect(mapper.canMap(new Error('other'))).toBe(false);
  });
});
