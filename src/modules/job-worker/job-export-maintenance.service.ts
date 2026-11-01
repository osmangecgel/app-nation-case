import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '#core/config/env.validation.ts';
import { RequestContext } from '#core/context/request-context.ts';
import { generateRequestId } from '#core/context/request-id.ts';
import { JobExportRunService } from '#modules/job-exports/job-export-run.service.ts';
import { describeError } from '#shared/describe-error.ts';
import { JobWorkerLogEvent } from './job-worker.constants.ts';

// Runs the export reconciler and file cleanup (JobExportRunService.maintain)
// on the reconciler's interval, in every worker.
@Injectable()
export class JobExportMaintenanceService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(JobExportMaintenanceService.name);
  private readonly intervalMs: number;
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private stopped = false;

  constructor(
    private readonly runs: JobExportRunService,
    private readonly context: RequestContext,
    config: ConfigService<Env, true>,
  ) {
    this.intervalMs = config.get('RECONCILER_INTERVAL_MS', { infer: true });
  }

  onApplicationBootstrap(): void {
    this.schedule();
  }

  // Waits for a run in progress, so its connections are not closed under it.
  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }

  private schedule(): void {
    if (!this.stopped) {
      this.timer = setTimeout(() => {
        this.running = this.context.run({ requestId: generateRequestId() }, () => this.runOnce());
      }, this.intervalMs);
    }
  }

  private async runOnce(): Promise<void> {
    try {
      await this.runs.maintain();
    } catch (error) {
      this.logger.error(JobWorkerLogEvent.RECONCILER_FAILED, { reason: describeError(error) });
    } finally {
      this.schedule();
    }
  }
}
