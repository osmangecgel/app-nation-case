import { ConfigModule } from '@nestjs/config';
import { type Env, validateEnv } from './env.validation.ts';

// For module setup that must decide before any provider exists (which queue
// driver to load): waits until ConfigModule has read .env, then validates the
// variables exactly as ConfigService does.
export async function loadedEnv(): Promise<Env> {
  await ConfigModule.envVariablesLoaded;
  return validateEnv(process.env);
}
