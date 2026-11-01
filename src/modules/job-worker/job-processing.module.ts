import { Module } from '@nestjs/common';
import { AiProviderModule } from '#infra/ai-provider/ai-provider.module.ts';
import { JobConfigModule } from '#modules/job-config/job-config.module.ts';
import { JobContentsModule } from '#modules/job-contents/job-contents.module.ts';
import { JobOutboxModule } from '#modules/job-outbox/job-outbox.module.ts';
import { JobLifecycleModule } from '#modules/jobs/job-lifecycle.module.ts';
import { UsersModule } from '#modules/users/users.module.ts';
import { JobProcessorService } from './job-processor.service.ts';
import { JobReconcilerService } from './job-reconciler.service.ts';
import { JobResultCacheService } from './job-result-cache.service.ts';
import { JobResolverService } from './job-resolver.service.ts';
import { JobSettlementService } from './job-settlement.service.ts';

// Processing a job and recovering stuck ones, without Kafka: the worker feeds
// it from Kafka, tests call it directly.
@Module({
  imports: [AiProviderModule, UsersModule, JobConfigModule, JobContentsModule, JobOutboxModule, JobLifecycleModule],
  providers: [
    JobProcessorService,
    JobResolverService,
    JobResultCacheService,
    JobSettlementService,
    JobReconcilerService,
  ],
  exports: [JobProcessorService, JobReconcilerService],
})
export class JobProcessingModule {}
