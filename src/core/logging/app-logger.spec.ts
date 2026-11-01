import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { stripVTControlCharacters } from 'node:util';
import { LogFormat, LogLevel } from '#core/config/env.constants.ts';
import { RequestContext } from '#core/context/request-context.ts';
import { AppLogger } from './app-logger.ts';

const REQUEST_ID = '4bf92f3577b34da6a3ce929d0e0e4736';

async function createLogger(
  format: LogFormat,
  level: LogLevel,
): Promise<{ logger: AppLogger; context: RequestContext }> {
  const settings: Record<string, string> = { LOG_FORMAT: format, LOG_LEVEL: level };
  const moduleRef = await Test.createTestingModule({
    providers: [
      AppLogger,
      RequestContext,
      { provide: ConfigService, useValue: { get: (key: string) => settings[key] } },
    ],
  }).compile();
  return { logger: moduleRef.get(AppLogger), context: moduleRef.get(RequestContext) };
}

function captureStdout(): () => string {
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  return () => write.mock.calls.map(([chunk]) => String(chunk)).join('');
}

describe('AppLogger', () => {
  it('gives a line outside any request or job a request id too (LOG-02)', async () => {
    const { logger } = await createLogger(LogFormat.JSON, LogLevel.LOG);
    const output = captureStdout();

    logger.log('WORKER_STARTED', 'JobConsumerService');

    expect(JSON.parse(output())).toMatchObject({ requestId: expect.stringMatching(/^[0-9a-f]{32}$/) });
  });

  afterEach(() => vi.restoreAllMocks());

  it('adds the request id of the current request to every JSON line (LOG-02)', async () => {
    const { logger, context } = await createLogger(LogFormat.JSON, LogLevel.LOG);
    const output = captureStdout();

    context.run({ requestId: REQUEST_ID }, () => logger.log('Order created', { orderId: 'o-1' }, 'OrdersService'));

    expect(JSON.parse(output())).toEqual(
      expect.objectContaining({ message: 'Order created', requestId: REQUEST_ID, orderId: 'o-1' }),
    );
  });

  it('masks sensitive fields at any depth (LOG-07)', async () => {
    const { logger } = await createLogger(LogFormat.JSON, LogLevel.LOG);
    const output = captureStdout();

    logger.log('REQUEST_RECEIVED', { body: { email: 'a@example.com', Password: 'secret' } }, 'HTTP');

    expect(JSON.parse(output()).body).toEqual({ email: 'a@example.com', Password: '[MASKED]' });
  });

  it('writes no empty field object outside a request', async () => {
    const { logger } = await createLogger(LogFormat.PRETTY, LogLevel.LOG);
    const output = captureStdout();

    logger.log('Application started', 'NestApplication');

    expect(output()).not.toContain('{}');
  });

  it('prints an event code next to the context in pretty lines (LOG-03)', async () => {
    const { logger, context } = await createLogger(LogFormat.PRETTY, LogLevel.LOG);
    const output = captureStdout();

    context.run({ requestId: REQUEST_ID }, () => {
      logger.log('REQUEST_RECEIVED', { method: 'GET' }, 'HTTP');
      logger.log('Order created', 'OrdersService');
    });

    const lines = stripVTControlCharacters(output());
    expect(lines).toContain(` [HTTP][REQUEST_RECEIVED] { requestId: '${REQUEST_ID}', method: 'GET' }`);
    expect(lines).toContain(' [OrdersService] Order created');
  });

  it('writes the event code as the message in JSON lines', async () => {
    const { logger } = await createLogger(LogFormat.JSON, LogLevel.LOG);
    const output = captureStdout();

    logger.log('REQUEST_RECEIVED', 'HTTP');

    expect(JSON.parse(output())).toEqual(expect.objectContaining({ message: 'REQUEST_RECEIVED', context: 'HTTP' }));
  });

  it('skips levels below LOG_LEVEL (LOG-05)', async () => {
    const { logger } = await createLogger(LogFormat.JSON, LogLevel.WARN);
    const output = captureStdout();

    logger.log('Ignored', 'Test');

    expect(output()).toBe('');
  });
});
