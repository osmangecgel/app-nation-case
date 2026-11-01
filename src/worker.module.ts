import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from '#core/config/env.validation.ts';
import { ContextModule } from '#core/context/context.module.ts';
import { LoggingModule } from '#core/logging/logging.module.ts';
import { CacheModule } from '#infra/cache/cache.module.ts';
import { PrismaModule } from '#infra/database/prisma.module.ts';
import { JobWorkerModule } from '#modules/job-worker/job-worker.module.ts';

// The worker has no HTTP server; it shares configuration, logging and the
// database with the API, and adds Kafka and the AI providers.
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv, expandVariables: true }),
    ContextModule,
    LoggingModule,
    PrismaModule,
    CacheModule,
    JobWorkerModule,
  ],
})
export class WorkerModule {}
