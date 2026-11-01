import { Inject, Injectable } from '@nestjs/common';
import type { AiProvider } from './ai-provider.ts';
import { ConcurrencyTrackingAiProvider } from './concurrency-tracking-ai-provider.ts';

// The adapters this build supports. Tests replace it with a controllable provider.
export const AI_PROVIDERS = Symbol('AI_PROVIDERS');

// Finds the adapter a job_providers row names. Each adapter is wrapped once, so
// its concurrency count covers every job that uses it.
@Injectable()
export class AiProviderRegistry {
  private readonly providers: Map<string, AiProvider>;

  constructor(@Inject(AI_PROVIDERS) providers: AiProvider[]) {
    this.providers = new Map(
      providers.map((provider) => [provider.adapter, new ConcurrencyTrackingAiProvider(provider)]),
    );
  }

  find(adapter: string): AiProvider | undefined {
    return this.providers.get(adapter);
  }

  adapters(): string[] {
    return [...this.providers.keys()];
  }
}
