import { Module } from '@nestjs/common';
import { QueueModule } from '#infra/queue/queue.module.ts';
import { JobOutboxRelayService } from './job-outbox-relay.service.ts';

// The relay, separate from JobOutboxModule so the API can write outbox rows
// without loading the queue driver.
@Module({
  imports: [QueueModule.register()],
  providers: [JobOutboxRelayService],
  exports: [JobOutboxRelayService],
})
export class JobOutboxRelayModule {}
