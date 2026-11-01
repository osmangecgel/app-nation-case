import { Module } from '@nestjs/common';
import { JobIdempotencyCleanupService } from './job-idempotency-cleanup.service.ts';

// The cleanup loop, separate from JobIdempotencyModule so it runs in the
// worker only, not in every API instance.
@Module({
  providers: [JobIdempotencyCleanupService],
  exports: [JobIdempotencyCleanupService],
})
export class JobIdempotencyCleanupModule {}
