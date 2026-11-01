import { Injectable, Logger } from '@nestjs/common';
import type { Writable } from 'node:stream';
import type { Response } from 'express';
import { PrismaService } from '#infra/database/prisma.service.ts';
import { describeError } from '#shared/describe-error.ts';
import { JOB_LIST_SELECT, toJobListItemDto } from '#modules/jobs/dto/job.dto.ts';
import { JOB_CSV_HEADER, toJobCsvLine } from './job-csv.ts';
import { EXPORT_BATCH_SIZE, JobExportLogEvent } from './job-exports.constants.ts';

const CSV_CONTENT_TYPE = 'text/csv; charset=utf-8';
const CSV_DISPOSITION = 'attachment; filename="jobs.csv"';

// Resolves when the reader (a client, or a file) has taken enough to accept
// more, or has gone away. A stream already closed gets neither event again,
// so it resolves at once.
function waitForDrain(out: Writable): Promise<void> {
  if (out.destroyed || out.writableEnded) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const done = (): void => {
      out.off('drain', done);
      out.off('close', done);
      resolve();
    };
    out.on('drain', done);
    out.on('close', done);
  });
}

// Streams every job of the user as CSV, newest first.
//
// - Memory: at most EXPORT_BATCH_SIZE rows at a time, for any number of jobs.
// - Backpressure: when the client reads slowly, write() returns false and the
//   loop waits for 'drain' before reading the next batch from the database.
// - No long transaction: each batch is a short keyset query, so a slow client
//   holds no database connection, lock or snapshot while it reads (a
//   transaction held open for minutes would block vacuum on jobs).
// - Disconnect: 'close' stops the loop; the batch query in flight, if any,
//   takes milliseconds and nothing else is left open.
@Injectable()
export class JobExportService {
  private readonly logger = new Logger(JobExportService.name);

  constructor(private readonly prisma: PrismaService) {}

  // Whether the user has more than `count` jobs, without counting them all:
  // reads at most count + 1 entries of the (user_id, id) index.
  async hasMoreJobsThan(userId: string, count: number): Promise<boolean> {
    const [row] = await this.prisma.$queryRaw<{ found: number }[]>`
      SELECT count(*)::int AS found FROM (SELECT 1 FROM jobs WHERE user_id = ${userId} LIMIT ${count + 1}::int) t`;
    return (row?.found ?? 0) > count;
  }

  async writeCsv(userId: string, response: Response): Promise<void> {
    let closed = response.destroyed;
    response.on('close', () => {
      closed = true;
    });
    response.status(200).type(CSV_CONTENT_TYPE).setHeader('Content-Disposition', CSV_DISPOSITION);
    this.logger.log(JobExportLogEvent.JOB_EXPORT_STARTED, { userId });
    try {
      const rows = await this.writeRows(userId, response, () => closed);
      if (closed) {
        this.logger.log(JobExportLogEvent.JOB_EXPORT_ABORTED, { userId, rows });
        return;
      }
      response.end();
      this.logger.log(JobExportLogEvent.JOB_EXPORT_FINISHED, { userId, rows });
    } catch (error) {
      // The status line is already sent; cutting the connection is the only way
      // to tell the client the file is incomplete instead of letting it look whole.
      this.logger.error(JobExportLogEvent.JOB_EXPORT_FAILED, { userId, reason: describeError(error) });
      response.destroy(error instanceof Error ? error : undefined);
    }
  }

  // Writes the header and every job of the user to `out`, honouring its
  // backpressure, until done or isClosed(). The HTTP export and the background
  // export (a file) share it. Returns the number of rows written.
  async writeRows(userId: string, out: Writable, isClosed: () => boolean): Promise<number> {
    let written = 0;
    let cursor: string | undefined;
    if (!out.write(JOB_CSV_HEADER)) {
      await waitForDrain(out);
    }
    while (!isClosed()) {
      const rows = await this.prisma.job.findMany({
        where: { user_id: userId, ...(cursor ? { id: { lt: cursor } } : {}) },
        orderBy: { id: 'desc' },
        take: EXPORT_BATCH_SIZE,
        select: JOB_LIST_SELECT,
      });
      if (rows.length === 0) {
        break;
      }
      written += rows.length;
      cursor = rows[rows.length - 1].id;
      if (!out.write(rows.map((row) => toJobCsvLine(toJobListItemDto(row))).join(''))) {
        await waitForDrain(out);
      }
      if (rows.length < EXPORT_BATCH_SIZE) {
        break;
      }
    }
    return written;
  }
}
