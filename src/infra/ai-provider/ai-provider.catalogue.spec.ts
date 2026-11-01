import { type AiProviderFactory, loadAiProviders } from './ai-provider.catalogue.ts';
import type { AiProvider } from './ai-provider.ts';

const provider = (adapter: string): AiProvider => ({ adapter, generate: vi.fn() });
const config = {} as never;

describe('loadAiProviders', () => {
  const catalogue: Record<string, AiProviderFactory> = {
    first: () => provider('first'),
    second: () => provider('second'),
  };

  it('builds only the adapters that are named', () => {
    expect(loadAiProviders(catalogue, ['second'], config).map((loaded) => loaded.adapter)).toEqual(['second']);
  });

  it('stops at startup on an unknown name and lists the known ones', () => {
    expect(() => loadAiProviders(catalogue, ['first', 'openai'], config)).toThrow(
      'Unknown AI provider adapter "openai" in AI_PROVIDER_ADAPTERS. Known: first, second.',
    );
  });
});
