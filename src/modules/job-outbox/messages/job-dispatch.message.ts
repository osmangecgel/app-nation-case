import { z } from 'zod';
import type { QueueMessage } from '#infra/queue/queue.ts';

// The messages the outbox relay sends and the worker reads: one names a job,
// the other a background export. They only name it: its state is in the
// database, so a duplicate or late message changes nothing. Fields are
// snake_case like every message field (CODE-03).
const JobDispatchSchema = z.object({ job_id: z.uuid() });
const ExportDispatchSchema = z.object({ export_id: z.uuid() });

// The API request that created the job, so the worker's log lines carry it.
const REQUEST_ID_HEADER = 'request_id';

// What is dispatched: a job or an export (one outbox row has exactly one).
export type DispatchSubject = { jobId: string } | { exportId: string };

export type DispatchMessageFields = DispatchSubject & {
  topic: string;
  // Jobs: the content hash, so jobs with the same content go to the same
  // partition, the same worker, and share one provider call there.
  messageKey: string;
  requestId: string;
};

export function toDispatchMessage(dispatch: DispatchMessageFields): QueueMessage {
  const value =
    'jobId' in dispatch
      ? ({ job_id: dispatch.jobId } satisfies z.infer<typeof JobDispatchSchema>)
      : ({ export_id: dispatch.exportId } satisfies z.infer<typeof ExportDispatchSchema>);
  return {
    topic: dispatch.topic,
    key: dispatch.messageKey,
    value: JSON.stringify(value),
    headers: { [REQUEST_ID_HEADER]: dispatch.requestId },
  };
}

function parse<T>(schema: z.ZodType<T>, value: string | null): T | null {
  try {
    const parsed = schema.safeParse(JSON.parse(value ?? ''));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// Null when the message names no job (it can never be processed).
export function jobIdOf(value: string | null): string | null {
  return parse(JobDispatchSchema, value)?.job_id ?? null;
}

// Null when the message names no export.
export function exportIdOf(value: string | null): string | null {
  return parse(ExportDispatchSchema, value)?.export_id ?? null;
}

export function requestIdOf(headers: Record<string, string>): string | undefined {
  return headers[REQUEST_ID_HEADER];
}
