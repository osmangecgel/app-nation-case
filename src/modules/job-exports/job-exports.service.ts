import type { Readable } from 'node:stream';
import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { NotFoundError } from '#core/errors/app-errors.ts';
import { PrismaService } from '#infra/database/prisma.service.ts';
import { FileStore } from '#infra/file-store/file-store.ts';
import { JobOutboxService } from '#modules/job-outbox/job-outbox.service.ts';
import { Prisma } from '#generated/prisma/client.ts';
import { uuidV7 } from '#shared/uuid-v7.ts';
import { type JobExportDto, type JobExportRow, toJobExportDto } from './dto/job-export.dto.ts';
import { EXPORT_REUSE_WINDOW_MS, JobExportErrorCode, JobExportLogEvent } from './job-exports.constants.ts';

const EXPORT_COLUMNS = Prisma.sql`id, status, row_count, error_code, created_at, finished_at, expires_at`;

export type ExportRequest = { export: JobExportDto; created: boolean };

// The file of a background export is named after it.
export function exportFileKey(exportId: string): string {
  return `${exportId}.csv`;
}

function notFound(): NotFoundError {
  return new NotFoundError(JobExportErrorCode.EXPORT_NOT_FOUND, 'Export was not found.');
}

// A malformed id is reported like another user's export.
function assertExportId(exportId: string): void {
  if (!z.uuid().safeParse(exportId).success) {
    throw notFound();
  }
}

// Background CSV exports, the API side (the Asynchronous Request-Reply
// pattern): a request is accepted at once, the worker prepares the file
// (JobExportRunService), the client polls the export and downloads the file.
@Injectable()
export class JobExportsService {
  private readonly logger = new Logger(JobExportsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: JobOutboxService,
    private readonly files: FileStore,
  ) {}

  // Returns the user's unfinished export, or a ready one from the last few
  // minutes, instead of preparing the same file twice.
  async request(userId: string, requestId: string): Promise<ExportRequest> {
    const recent = await this.findRecentReady(userId);
    if (recent) {
      return { export: toJobExportDto(recent), created: false };
    }
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) {
      throw new NotFoundError(JobExportErrorCode.EXPORT_NOT_FOUND, 'There are no jobs to export.');
    }
    return this.prisma.$transaction(async (tx) => {
      const [created] = await tx.$queryRaw<JobExportRow[]>`
        INSERT INTO job_exports (id, user_id, updated_at) VALUES (${uuidV7()}::uuid, ${userId}, now())
        ON CONFLICT (user_id) WHERE status IN ('queued', 'processing') DO NOTHING
        RETURNING ${EXPORT_COLUMNS}`;
      if (created) {
        // In the same transaction, so an accepted export is always dispatched.
        await this.outbox.enqueueExport(tx, { exportId: created.id, requestId });
        this.logger.log(JobExportLogEvent.EXPORT_REQUESTED, { exportId: created.id, userId });
        return { export: toJobExportDto(created), created: true };
      }
      const [active] = await tx.$queryRaw<JobExportRow[]>`
        SELECT ${EXPORT_COLUMNS} FROM job_exports
         WHERE user_id = ${userId} AND status IN ('queued', 'processing')`;
      if (!active) {
        // It finished between the insert and this read; the client can ask again.
        throw notFound();
      }
      return { export: toJobExportDto(active), created: false };
    });
  }

  async get(userId: string, exportId: string): Promise<JobExportDto> {
    return toJobExportDto(await this.find(userId, exportId));
  }

  // Stops an unfinished export; a finished one is returned as it is.
  async cancel(userId: string, exportId: string): Promise<JobExportDto> {
    await this.find(userId, exportId);
    const [canceled] = await this.prisma.$queryRaw<JobExportRow[]>`
      UPDATE job_exports
         SET status = 'canceled', finished_at = now(), lock_token = NULL, locked_until = NULL, updated_at = now()
       WHERE id = ${exportId}::uuid AND user_id = ${userId} AND status IN ('queued', 'processing')
      RETURNING ${EXPORT_COLUMNS}`;
    return canceled ? toJobExportDto(canceled) : this.get(userId, exportId);
  }

  // The prepared file, while the export is ready and not expired.
  async openFile(userId: string, exportId: string): Promise<Readable> {
    const fileMissing = new NotFoundError(
      JobExportErrorCode.EXPORT_FILE_NOT_FOUND,
      'The export has no file to download.',
    );
    assertExportId(exportId);
    // Expiry is judged by the database clock (DB-21).
    const [row] = await this.prisma.$queryRaw<{ downloadable: boolean }[]>`
      SELECT status = 'ready' AND expires_at > now() AS downloadable
        FROM job_exports WHERE id = ${exportId}::uuid AND user_id = ${userId}`;
    if (!row) {
      throw notFound();
    }
    if (!row.downloadable) {
      throw fileMissing;
    }
    const file = await this.files.open(exportFileKey(exportId));
    if (!file) {
      throw fileMissing;
    }
    return file;
  }

  private async find(userId: string, exportId: string): Promise<JobExportRow> {
    assertExportId(exportId);
    const [row] = await this.prisma.$queryRaw<JobExportRow[]>`
      SELECT ${EXPORT_COLUMNS} FROM job_exports WHERE id = ${exportId}::uuid AND user_id = ${userId}`;
    if (!row) {
      throw notFound();
    }
    return row;
  }

  private async findRecentReady(userId: string): Promise<JobExportRow | undefined> {
    const [row] = await this.prisma.$queryRaw<JobExportRow[]>`
      SELECT ${EXPORT_COLUMNS} FROM job_exports
       WHERE user_id = ${userId} AND status = 'ready' AND expires_at > now()
         AND created_at > now() - make_interval(secs => ${EXPORT_REUSE_WINDOW_MS / 1000}::double precision)
       ORDER BY id DESC
       LIMIT 1`;
    return row;
  }
}
