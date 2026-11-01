import { Module } from '@nestjs/common';
import { FileStoreModule } from '#infra/file-store/file-store.module.ts';
import { JobOutboxModule } from '#modules/job-outbox/job-outbox.module.ts';
import { ExportAdmissionService } from './export-admission.service.ts';
import { ExportDownloadService } from './export-download.service.ts';
import { ExportsController } from './exports.controller.ts';
import { JobExportRunModule } from './job-export-run.module.ts';
import { JobExportsService } from './job-exports.service.ts';

// Owns job_exports: CSV exports of a user's jobs, streamed or prepared in the
// background (API-12, API-15, API-16). Reads jobs, writes only its own table;
// the jobs module serves GET /v1/jobs/export.csv through ExportDownloadService.
@Module({
  imports: [JobExportRunModule, JobOutboxModule, FileStoreModule],
  controllers: [ExportsController],
  providers: [JobExportsService, ExportAdmissionService, ExportDownloadService],
  exports: [ExportDownloadService],
})
export class JobExportsModule {}
