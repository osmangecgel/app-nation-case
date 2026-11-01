import type { ArgumentsHost } from '@nestjs/common';
import { HttpStatus, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { RequestContext } from '#core/context/request-context.ts';
import { NotFoundError } from './app-errors.ts';
import { CommonErrorCode } from './error-codes.ts';
import { AppErrorMapper } from './mappers/app-error.mapper.ts';
import { ProblemDetailsFilter } from './problem-details.filter.ts';
import { PROBLEM_MAPPERS } from './problem-mapper.ts';

type SentResponse = { status: number; body: Record<string, string | number> };

async function createFilter(includeStack: boolean): Promise<ProblemDetailsFilter> {
  const moduleRef = await Test.createTestingModule({
    providers: [
      ProblemDetailsFilter,
      RequestContext,
      { provide: PROBLEM_MAPPERS, useValue: [new AppErrorMapper()] },
      { provide: ConfigService, useValue: { get: vi.fn().mockReturnValue(includeStack) } },
    ],
  }).compile();
  return moduleRef.get(ProblemDetailsFilter);
}

function fakeHost(): { host: ArgumentsHost; sent: SentResponse } {
  const sent: SentResponse = { status: 0, body: {} };
  const response = {
    status: (code: number) => {
      sent.status = code;
      return response;
    },
    type: () => response,
    json: (body: SentResponse['body']) => {
      sent.body = body;
    },
  };
  const host = {
    switchToHttp: () => ({ getRequest: () => ({ path: '/v1/products' }), getResponse: () => response }),
  } as never as ArgumentsHost;
  return { host, sent };
}

describe('ProblemDetailsFilter', () => {
  let warnLog: ReturnType<typeof vi.spyOn>;
  let errorLog: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnLog = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    errorLog = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => vi.restoreAllMocks());

  it('adds the stack trace when ERROR_INCLUDE_STACK is on (ERR-08)', async () => {
    const filter = await createFilter(true);
    const { host, sent } = fakeHost();

    filter.catch(new NotFoundError('PRODUCT_NOT_FOUND', 'Product was not found.'), host);

    expect(sent.body.stack).toContain('NotFoundError');
  });

  it('leaves the stack trace out by default', async () => {
    const filter = await createFilter(false);
    const { host, sent } = fakeHost();

    filter.catch(new NotFoundError('PRODUCT_NOT_FOUND', 'Product was not found.'), host);

    expect(sent.body).not.toHaveProperty('stack');
  });

  it('adds the lowercase code as error (ERR-01)', async () => {
    const filter = await createFilter(false);
    const { host, sent } = fakeHost();

    filter.catch(new NotFoundError('PRODUCT_NOT_FOUND', 'Product was not found.'), host);

    expect(sent.body).toMatchObject({ code: 'PRODUCT_NOT_FOUND', error: 'product_not_found' });
  });

  it('logs a 4xx as a warning (LOG-05)', async () => {
    const filter = await createFilter(false);
    const { host } = fakeHost();

    filter.catch(new NotFoundError('PRODUCT_NOT_FOUND', 'Product was not found.'), host);

    expect(warnLog).toHaveBeenCalledWith('REQUEST_REJECTED', {
      code: 'PRODUCT_NOT_FOUND',
      status: HttpStatus.NOT_FOUND,
    });
  });

  it('treats a thrown non-error value as an unexpected 500 and logs it', async () => {
    const filter = await createFilter(false);
    const { host, sent } = fakeHost();

    filter.catch('plain string', host);

    expect(sent.status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(sent.body.code).toBe(CommonErrorCode.INTERNAL_ERROR);
    expect(errorLog).toHaveBeenCalledWith('REQUEST_FAILED', expect.any(Object), 'plain string');
  });
});
