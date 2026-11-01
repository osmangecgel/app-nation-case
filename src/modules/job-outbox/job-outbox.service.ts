import { Injectable } from '@nestjs/common';
import type { Prisma } from '#generated/prisma/client.ts';
import { uuidV7 } from '#shared/uuid-v7.ts';
import { EXPORT_DISPATCH_TOPIC, JOB_DISPATCH_TOPIC } from './job-outbox.constants.ts';

export type JobDispatch = {
  jobId: string;
  // Jobs with the same content share a key, so they land on the same partition.
  messageKey: string;
  requestId: string;
  // Not published before this time (retry backoff); now when absent.
  notBefore?: Date;
};

// Owns job_outbox_messages: messages to publish to Kafka, written in the same
// transaction as the job change that causes them, so a committed change is
// always published and a rolled-back one never is.
@Injectable()
export class JobOutboxService {
  async enqueue(tx: Prisma.TransactionClient, dispatch: JobDispatch): Promise<void> {
    await tx.jobOutboxMessage.create({
      data: {
        id: uuidV7(),
        job_id: dispatch.jobId,
        topic: JOB_DISPATCH_TOPIC,
        message_key: dispatch.messageKey,
        request_id: dispatch.requestId,
        ...(dispatch.notBefore ? { not_before: dispatch.notBefore } : {}),
      },
      select: { id: true },
    });
  }

  // A background export's dispatch. Keyed by the export id, so exports spread
  // over the partitions.
  async enqueueExport(
    tx: Prisma.TransactionClient,
    dispatch: { exportId: string; requestId: string; notBefore?: Date },
  ): Promise<void> {
    await tx.jobOutboxMessage.create({
      data: {
        id: uuidV7(),
        export_id: dispatch.exportId,
        topic: EXPORT_DISPATCH_TOPIC,
        message_key: dispatch.exportId,
        request_id: dispatch.requestId,
        ...(dispatch.notBefore ? { not_before: dispatch.notBefore } : {}),
      },
      select: { id: true },
    });
  }

  // The request that created the job, from its latest message. Null once
  // cleanup has deleted the job's messages (an hour after they were sent).
  async findRequestId(tx: Prisma.TransactionClient, jobId: string): Promise<string | null> {
    const message = await tx.jobOutboxMessage.findFirst({
      where: { job_id: jobId },
      orderBy: { created_at: 'desc' },
      select: { request_id: true },
    });
    return message?.request_id ?? null;
  }
}
