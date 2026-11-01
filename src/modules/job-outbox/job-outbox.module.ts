import { Module } from '@nestjs/common';
import { JobOutboxService } from './job-outbox.service.ts';

@Module({
  providers: [JobOutboxService],
  exports: [JobOutboxService],
})
export class JobOutboxModule {}
