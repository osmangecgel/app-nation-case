import type { ConfigService } from '@nestjs/config';
import type { Env } from '#core/config/env.validation.ts';
import type { AiProvider } from './ai-provider.ts';
import { FAKE_ADAPTER, FakeAiProvider } from './adapters/fake/fake-ai-provider.ts';

export type AiProviderFactory = (config: ConfigService<Env, true>) => AiProvider;

// Every AI provider adapter this build can load, by the name in
// job_providers.adapter. Adding a provider:
//   1. implement AiProvider in adapters/<name>/ (map its errors to
//      TransientAiError / PermanentAiError, honour the abort signal);
//   2. add one entry here; read its settings (API key, URL) from config;
//   3. add <name> to AI_PROVIDER_ADAPTERS and a job_providers row with a route.
// The worker, the registry and the concurrency limit do not change.
export const AI_PROVIDER_CATALOGUE: Record<string, AiProviderFactory> = {
  [FAKE_ADAPTER]: () => new FakeAiProvider(),
};

// Builds the adapters AI_PROVIDER_ADAPTERS names. An unknown name stops the
// worker at startup instead of failing every job that would use it.
export function loadAiProviders(
  catalogue: Record<string, AiProviderFactory>,
  names: string[],
  config: ConfigService<Env, true>,
): AiProvider[] {
  return names.map((name) => {
    const create = catalogue[name];
    if (!create) {
      const known = Object.keys(catalogue).join(', ');
      throw new Error(`Unknown AI provider adapter "${name}" in AI_PROVIDER_ADAPTERS. Known: ${known}.`);
    }
    return create(config);
  });
}
