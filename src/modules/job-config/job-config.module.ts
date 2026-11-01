import { Module } from '@nestjs/common';
import { JobConfigService } from './job-config.service.ts';

// Owns job_types, job_providers and job_type_routes: read together, kept in memory together.
@Module({
  providers: [JobConfigService],
  exports: [JobConfigService],
})
export class JobConfigModule {}
