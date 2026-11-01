import { Injectable } from '@nestjs/common';
import { ConflictError } from '#core/errors/app-errors.ts';
import { CommonErrorCode } from '#core/errors/error-codes.ts';
import { PrismaService } from '#infra/database/prisma.service.ts';
import type { Prisma } from '#generated/prisma/client.ts';
import { uuidV7 } from '#shared/uuid-v7.ts';
import { MAX_CONTENT_UPSERT_ATTEMPTS } from './job-contents.constants.ts';

export type ContentForProcessing = {
  id: string;
  jobTypeCode: string;
  // Normalised: what the provider receives, the same for every job sharing the row.
  input: string;
  // Hex of the content hash: the Kafka message key and the cache key of jobs with this content.
  messageKey: string;
};

export type ContentToStore = {
  jobTypeCode: string;
  contentHash: Buffer;
  normalizedInput: string;
};

// Owns job_contents: one row per job type and normalised input, shared by every
// job (of any user) with that content.
@Injectable()
export class JobContentsService {
  constructor(private readonly prisma: PrismaService) {}

  // Returns the id of the existing or new row. The SELECT branch finds a row
  // committed before this statement; a row committed while the INSERT waited on
  // it is outside the statement's snapshot, so the statement is retried.
  async upsert(tx: Prisma.TransactionClient, content: ContentToStore): Promise<string> {
    for (let attempt = 0; attempt < MAX_CONTENT_UPSERT_ATTEMPTS; attempt += 1) {
      const [row] = await tx.$queryRaw<{ id: string }[]>`
        WITH inserted AS (
          INSERT INTO job_contents (id, job_type_code, content_hash, input, updated_at)
          VALUES (${uuidV7()}::uuid, ${content.jobTypeCode}, ${content.contentHash}, ${content.normalizedInput}, now())
          ON CONFLICT (job_type_code, content_hash) DO NOTHING
          RETURNING id
        )
        SELECT id FROM inserted
        UNION ALL
        SELECT id FROM job_contents WHERE job_type_code = ${content.jobTypeCode} AND content_hash = ${content.contentHash}
        LIMIT 1`;
      if (row) {
        return row.id;
      }
    }
    throw new ConflictError(CommonErrorCode.CONFLICT, 'The request conflicted with a concurrent request. Try again.');
  }

  // Reads inside the given transaction, or on its own without one.
  async findForProcessing(contentId: string, tx?: Prisma.TransactionClient): Promise<ContentForProcessing> {
    const content = await (tx ?? this.prisma).jobContent.findUniqueOrThrow({
      where: { id: contentId },
      select: { id: true, job_type_code: true, input: true, content_hash: true },
    });
    return {
      id: content.id,
      jobTypeCode: content.job_type_code,
      input: content.input,
      messageKey: messageKeyOf(content.content_hash),
    };
  }

  // The stored result, whatever its age: the fallback when the cache Redis
  // does not have it (expired, evicted or down).
  async findResult(contentId: string): Promise<string | null> {
    const content = await this.prisma.jobContent.findUnique({ where: { id: contentId }, select: { result: true } });
    return content?.result ?? null;
  }

  // Written once and never changed: every job with this content shows the same
  // result, including jobs that finished long ago. If two provider calls for
  // the same content raced (a rare duplicate call), the first answer stays.
  async saveResult(tx: Prisma.TransactionClient, contentId: string, result: string): Promise<void> {
    await tx.jobContent.updateMany({
      where: { id: contentId, result: null },
      data: { result, result_at: new Date() },
    });
  }
}

export function messageKeyOf(contentHash: Uint8Array): string {
  return Buffer.from(contentHash).toString('hex');
}
