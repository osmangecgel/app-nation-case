import { Module } from '@nestjs/common';
import { JobLifecycleService } from './job-lifecycle.service.ts';

// The jobs table's state changes, without the HTTP endpoints, so the worker can
// use them without loading the API.
@Module({
  providers: [JobLifecycleService],
  exports: [JobLifecycleService],
})
export class JobLifecycleModule {}
