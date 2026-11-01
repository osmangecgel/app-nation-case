import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '#core/config/env.validation.ts';
import { AI_PROVIDER_CATALOGUE, loadAiProviders } from './ai-provider.catalogue.ts';
import { AI_PROVIDERS, AiProviderRegistry } from './ai-provider.registry.ts';

@Module({
  providers: [
    {
      provide: AI_PROVIDERS,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        loadAiProviders(AI_PROVIDER_CATALOGUE, config.get('AI_PROVIDER_ADAPTERS', { infer: true }), config),
    },
    AiProviderRegistry,
  ],
  exports: [AiProviderRegistry],
})
export class AiProviderModule {}
