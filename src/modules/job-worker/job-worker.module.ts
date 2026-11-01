import { Module } from '@nestjs/common';
import { QueueModule } from '#infra/queue/queue.module.ts';
import { JobIdempotencyCleanupModule } from '#modules/job-idempotency/job-idempotency-cleanup.module.ts';
import { JobOutboxRelayModule } from '#modules/job-outbox/job-outbox-relay.module.ts';
import { JobExportRunModule } from '#modules/job-exports/job-export-run.module.ts';
import { JobConsumerService } from './job-consumer.service.ts';
import { JobExportConsumerService } from './job-export-consumer.service.ts';
import { JobExportMaintenanceService } from './job-export-maintenance.service.ts';
import { JobProcessingModule } from './job-processing.module.ts';

// The worker process: consumes jobs and background exports from the queue,
// relays the outbox to it, runs the reconcilers and deletes expired
// idempotency keys and export files.
@Module({
  imports: [
    QueueModule.register(),
    JobProcessingModule,
    JobOutboxRelayModule,
    JobIdempotencyCleanupModule,
    JobExportRunModule,
  ],
  providers: [JobConsumerService, JobExportConsumerService, JobExportMaintenanceService],
})
export class JobWorkerModule {}
