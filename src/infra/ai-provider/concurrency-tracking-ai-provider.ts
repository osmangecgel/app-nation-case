import { Logger } from '@nestjs/common';
import { describeError } from '#shared/describe-error.ts';
import type { AiProvider, AiRequest, AiResult } from './ai-provider.ts';

const ProviderLogEvent = {
  PROVIDER_CALL_STARTED: 'PROVIDER_CALL_STARTED',
  PROVIDER_CALL_FINISHED: 'PROVIDER_CALL_FINISHED',
  PROVIDER_CALL_FAILED: 'PROVIDER_CALL_FAILED',
} as const;

// Wraps every provider and logs the calls in flight and the highest number
// seen so far, the case's check that a worker never exceeds its limit. It sits
// around the adapter, not inside it, so every provider gets it, including real
// ones added later. Input and output text are never logged.
export class ConcurrencyTrackingAiProvider implements AiProvider {
  readonly adapter: string;
  private readonly logger: Logger;
  private inFlight = 0;
  private highest = 0;

  constructor(private readonly provider: AiProvider) {
    this.adapter = provider.adapter;
    this.logger = new Logger(`AiProvider:${provider.adapter}`);
  }

  async generate(request: AiRequest, signal: AbortSignal): Promise<AiResult> {
    this.inFlight += 1;
    this.highest = Math.max(this.highest, this.inFlight);
    const startedAt = Date.now();
    this.logger.log(ProviderLogEvent.PROVIDER_CALL_STARTED, {
      jobType: request.jobType,
      concurrent: this.inFlight,
      maxConcurrent: this.highest,
    });
    try {
      const result = await this.provider.generate(request, signal);
      this.logger.log(ProviderLogEvent.PROVIDER_CALL_FINISHED, { durationMs: Date.now() - startedAt });
      return result;
    } catch (error) {
      this.logger.warn(ProviderLogEvent.PROVIDER_CALL_FAILED, {
        durationMs: Date.now() - startedAt,
        reason: describeError(error),
      });
      throw error;
    } finally {
      this.inFlight -= 1;
    }
  }
}
