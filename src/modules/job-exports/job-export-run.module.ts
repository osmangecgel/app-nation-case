import { Module } from '@nestjs/common';
import { FileStoreModule } from '#infra/file-store/file-store.module.ts';
import { JobOutboxModule } from '#modules/job-outbox/job-outbox.module.ts';
import { JobExportService } from './job-export.service.ts';
import { JobExportRunService } from './job-export-run.service.ts';

// Writing jobs as CSV and preparing background exports, without the HTTP
// endpoints, so the worker can use them without loading the API (ARCH-11).
@Module({
  imports: [JobOutboxModule, FileStoreModule],
  providers: [JobExportService, JobExportRunService],
  exports: [JobExportService, JobExportRunService],
})
export class JobExportRunModule {}
