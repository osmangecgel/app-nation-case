import type { ConfigService } from '@nestjs/config';
import { seconds, type ThrottlerModuleOptions, type ThrottlerStorage } from '@nestjs/throttler';
import type { Env } from '#core/config/env.validation.ts';

const RATE_LIMIT_MESSAGE = 'Too many requests. Try again later.';

// API-09: the default limit for every route, per client IP and route. The
// storage is passed in so core does not depend on infra (ARCH-02).
export function rateLimitOptions(config: ConfigService<Env, true>, storage: ThrottlerStorage): ThrottlerModuleOptions {
  return {
    throttlers: [
      {
        ttl: seconds(config.get('RATE_LIMIT_TTL_SECONDS', { infer: true })),
        limit: config.get('RATE_LIMIT_MAX', { infer: true }),
      },
    ],
    storage,
    errorMessage: RATE_LIMIT_MESSAGE,
  };
}
