import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { validateEnv } from '#core/config/env.validation.ts';
import { ContextModule } from '#core/context/context.module.ts';
import { AppErrorMapper } from '#core/errors/mappers/app-error.mapper.ts';
import { HttpErrorMapper } from '#core/errors/mappers/http-error.mapper.ts';
import { HttpExceptionMapper } from '#core/errors/mappers/http-exception.mapper.ts';
import { ProblemDetailsFilter } from '#core/errors/problem-details.filter.ts';
import { PROBLEM_MAPPERS, type ProblemMapper } from '#core/errors/problem-mapper.ts';
import { rateLimitOptions } from '#core/http/rate-limit.options.ts';
import { LoggingModule } from '#core/logging/logging.module.ts';
import { CacheModule } from '#infra/cache/cache.module.ts';
import { RedisThrottlerStorage } from '#infra/cache/redis-throttler.storage.ts';
import { PrismaErrorMapper } from '#infra/database/prisma-error.mapper.ts';
import { PrismaModule } from '#infra/database/prisma.module.ts';
import { HealthModule } from '#modules/health/health.module.ts';
import { JobsModule } from '#modules/jobs/jobs.module.ts';
import { UsersModule } from '#modules/users/users.module.ts';

@Module({
  imports: [
    // expandVariables: .env values may reference others, e.g. ${POSTGRES_PORT} in DATABASE_URL.
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv, expandVariables: true }),
    ContextModule,
    LoggingModule,
    PrismaModule,
    CacheModule,
    ThrottlerModule.forRootAsync({
      inject: [ConfigService, RedisThrottlerStorage],
      useFactory: rateLimitOptions,
    }),
    HealthModule,
    UsersModule,
    JobsModule,
  ],
  providers: [
    // The root module wires the mappers so core does not import infra (ARCH-02).
    {
      provide: PROBLEM_MAPPERS,
      useValue: [
        new AppErrorMapper(),
        new HttpExceptionMapper(),
        new HttpErrorMapper(),
        new PrismaErrorMapper(),
      ] satisfies ProblemMapper[],
    },
    { provide: APP_FILTER, useClass: ProblemDetailsFilter },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
