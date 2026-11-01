import { ConsoleLogger, Injectable, type LogLevel as NestLogLevel } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LogFormat, LogLevel } from '#core/config/env.constants.ts';
import type { Env } from '#core/config/env.validation.ts';
import { RequestContext } from '#core/context/request-context.ts';
import { maskSensitive } from './mask.ts';

const LEVELS_BY_SEVERITY = Object.values(LogLevel);
const EVENT_CODE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;

function enabledLevels(threshold: LogLevel): NestLogLevel[] {
  return LEVELS_BY_SEVERITY.slice(LEVELS_BY_SEVERITY.indexOf(threshold));
}

// NestJS ConsoleLogger with the project settings: JSON or coloured lines
// (LOG-04), LOG_LEVEL threshold (LOG-05), masking (LOG-07), and the request's
// requestId (and jobId in the worker) on every line (LOG-02).
@Injectable()
export class AppLogger extends ConsoleLogger {
  constructor(
    config: ConfigService<Env, true>,
    private readonly requestContext: RequestContext,
  ) {
    const json = config.get('LOG_FORMAT', { infer: true }) === LogFormat.JSON;
    super({
      json,
      colors: !json,
      flattenParams: true,
      logLevels: enabledLevels(config.get('LOG_LEVEL', { infer: true })),
    });
  }

  protected override printMessages(
    messages: unknown[],
    context?: string,
    logLevel?: NestLogLevel,
    writeStreamType?: 'stdout' | 'stderr',
    errorStack?: unknown,
    params?: Record<string, unknown>,
  ): void {
    // NestJS's own `redact` option only matches exact key names; maskSensitive
    // also catches variants such as new_password or api_key.
    const fields = maskSensitive({ ...this.requestContext.logFields(), ...params });
    const hasFields = Object.keys(fields).length > 0;
    super.printMessages(
      maskSensitive(messages),
      context,
      logLevel,
      writeStreamType,
      errorStack,
      hasFields ? fields : undefined,
    );
  }

  // LOG-03: a message that is an event code such as REQUEST_RECEIVED is
  // printed next to the context, [HTTP][REQUEST_RECEIVED]. Other messages keep
  // the NestJS form, [OrdersService] Order created. JSON lines are unchanged.
  protected override formatMessage(
    logLevel: NestLogLevel,
    message: unknown,
    pidMessage: string,
    formattedLogLevel: string,
    contextMessage: string,
    timestampDiff: string,
    params?: Record<string, unknown>,
  ): string {
    const isEventCode = typeof message === 'string' && EVENT_CODE.test(message);
    return super.formatMessage(
      logLevel,
      isEventCode ? `[${message}]` : message,
      pidMessage,
      formattedLogLevel,
      isEventCode ? contextMessage.replace('] ', ']') : contextMessage,
      timestampDiff,
      params,
    );
  }
}
