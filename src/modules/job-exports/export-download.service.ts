import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import type { Env } from '#core/config/env.validation.ts';
import { RequestContext } from '#core/context/request-context.ts';
import { generateRequestId } from '#core/context/request-id.ts';
import type { ExportMode } from '#core/config/env.constants.ts';
import { EXPORT_POLL_AFTER_SECONDS } from './job-exports.constants.ts';
import { ExportAdmissionService, type ExportPass } from './export-admission.service.ts';
import { ExportPlan, planExport } from './export-plan.ts';
import { JobExportService } from './job-export.service.ts';
import { JobExportsService } from './job-exports.service.ts';

// The path of an export's status; a 202 points the client there.
export function exportLocation(exportId: string): string {
  return `/v1/exports/${exportId}`;
}

// GET /v1/jobs/export.csv: streams the file through admission control, or
// accepts a background export, by EXPORT_MODE (see planExport).
@Injectable()
export class ExportDownloadService {
  private readonly mode: ExportMode;
  private readonly streamMaxRows: number;

  constructor(
    private readonly admission: ExportAdmissionService,
    private readonly jobExport: JobExportService,
    private readonly exports: JobExportsService,
    private readonly context: RequestContext,
    config: ConfigService<Env, true>,
  ) {
    this.mode = config.get('EXPORT_MODE', { infer: true });
    this.streamMaxRows = config.get('EXPORT_STREAM_MAX_ROWS', { infer: true });
  }

  async serve(userId: string, response: Response): Promise<void> {
    const plan = await planExport(this.mode, () => this.jobExport.hasMoreJobsThan(userId, this.streamMaxRows));
    if (plan === ExportPlan.BACKGROUND) {
      await this.accept(userId, response);
      return;
    }
    // A client that leaves while waiting for a slot stops the wait.
    const client = new AbortController();
    response.on('close', () => client.abort(new Error('Client disconnected.')));
    let pass: ExportPass;
    try {
      pass = await this.admission.admit(userId, client.signal);
    } catch (error) {
      if (client.signal.aborted) {
        return;
      }
      throw error;
    }
    try {
      await this.jobExport.writeCsv(userId, response);
    } finally {
      await pass.release();
    }
  }

  private async accept(userId: string, response: Response): Promise<void> {
    const requested = await this.exports.request(userId, this.context.requestId() ?? generateRequestId());
    response
      .status(HttpStatus.ACCEPTED)
      .location(exportLocation(requested.export.exportId))
      .setHeader('Retry-After', String(EXPORT_POLL_AFTER_SECONDS));
    response.json(requested.export);
  }
}
