import { Module } from '@nestjs/common';
import { JobIdempotencyService } from './job-idempotency.service.ts';

@Module({
  providers: [JobIdempotencyService],
  exports: [JobIdempotencyService],
})
export class JobIdempotencyModule {}
