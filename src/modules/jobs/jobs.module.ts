import { Module } from '@nestjs/common';
import { JobConfigModule } from '#modules/job-config/job-config.module.ts';
import { JobContentsModule } from '#modules/job-contents/job-contents.module.ts';
import { JobExportsModule } from '#modules/job-exports/job-exports.module.ts';
import { JobIdempotencyModule } from '#modules/job-idempotency/job-idempotency.module.ts';
import { JobOutboxModule } from '#modules/job-outbox/job-outbox.module.ts';
import { UsersModule } from '#modules/users/users.module.ts';
import { JobsController } from './jobs.controller.ts';
import { JobsService } from './jobs.service.ts';

// Owns jobs and the /v1/jobs endpoints. Creating a job orchestrates the modules
// that own the other tables, in one transaction.
@Module({
  imports: [UsersModule, JobConfigModule, JobContentsModule, JobIdempotencyModule, JobOutboxModule, JobExportsModule],
  controllers: [JobsController],
  providers: [JobsService],
})
export class JobsModule {}
