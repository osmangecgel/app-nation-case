import { config } from 'dotenv';
import { expand } from 'dotenv-expand';
import { z } from 'zod';

const ScriptEnvSchema = z.object({
  DATABASE_URL: z.url(),
});

export type ScriptEnv = z.output<typeof ScriptEnvSchema>;

// Command-line scripts (the seed) run outside Nest, so they read .env
// themselves, the same way prisma.config.ts does. In Docker the variables come
// from the container and .env is absent.
export function loadScriptEnv(): ScriptEnv {
  expand(config({ quiet: true }));
  const result = ScriptEnvSchema.safeParse(process.env);
  if (!result.success) {
    throw new Error(`Invalid environment variables:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
