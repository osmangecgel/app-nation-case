import { z } from 'zod';
import { CursorPaginationQuerySchema, pageSchemaOf } from '#core/http/pagination.ts';
import type { Prisma } from '#generated/prisma/client.ts';
import { JobStatus } from '#generated/prisma/enums.ts';

export const CreateJobSchema = z
  .strictObject({
    type: z.string().min(1).max(32).meta({ description: 'Job type.', example: 'summary' }),
    input: z
      .string()
      // PostgreSQL text cannot hold it; without this check the insert fails with a 500.
      .refine((text) => !text.includes('\u0000'), { message: 'Must not contain the NUL character (\\u0000).' })
      .meta({
        description:
          'Text to process. Must not be blank; the maximum length depends on the job type (20000 characters).',
        example: 'Merhaba dünya',
      }),
  })
  .meta({ id: 'CreateJob' });

export type CreateJobDto = z.infer<typeof CreateJobSchema>;

export const JobCreatedSchema = z
  .object({
    jobId: z.uuid().meta({ description: 'Id to query the job with.' }),
    status: z.literal(JobStatus.queued).meta({
      description: 'Always queued: a retried request returns the first response, even if the job has finished since.',
    }),
  })
  .meta({ id: 'JobCreated' });

export type JobCreatedDto = z.infer<typeof JobCreatedSchema>;

export const JobIdParamsSchema = z.strictObject({
  id: z.string().meta({ description: 'Job id.', example: '0192f3a1-7c4e-7b2a-9d1f-3e5a8b6c2d10' }),
});

export type JobIdParams = z.infer<typeof JobIdParamsSchema>;

const jobFields = {
  jobId: z.uuid(),
  type: z.string().meta({ example: 'summary' }),
  status: z.enum(JobStatus).meta({ example: JobStatus.completed }),
  errorCode: z.string().nullable().meta({ description: 'Set when the job failed.', example: null }),
  cost: z.number().int().meta({ description: 'Credits reserved for the job.', example: 3 }),
  createdAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable().meta({ description: 'Null while the job is queued or processing.' }),
};

export const JobSchema = z
  .object({
    ...jobFields,
    result: z.string().nullable().meta({ description: 'Set when the job completed.', example: 'Özet: merhaba dünya' }),
  })
  .meta({ id: 'Job' });

export type JobDto = z.infer<typeof JobSchema>;

export const JobListItemSchema = z.object(jobFields).meta({ id: 'JobListItem' });

export type JobListItemDto = z.infer<typeof JobListItemSchema>;

export const JobPageSchema = pageSchemaOf(JobListItemSchema).meta({ id: 'JobPage' });

export type JobPageDto = z.infer<typeof JobPageSchema>;

export const ListJobsQuerySchema = CursorPaginationQuerySchema.extend({
  status: z.enum(JobStatus).optional().meta({ description: 'Only jobs in this status.' }),
});

export type ListJobsQuery = z.infer<typeof ListJobsQuerySchema>;

// Columns of a job shown in lists and the CSV export (no text, no result).
export const JOB_LIST_SELECT = {
  id: true,
  status: true,
  error_code: true,
  cost: true,
  created_at: true,
  finished_at: true,
  content: { select: { job_type_code: true } },
} satisfies Prisma.JobSelect;

// A single job, with the result of its content.
export const JOB_DETAIL_SELECT = {
  ...JOB_LIST_SELECT,
  content: { select: { job_type_code: true, result: true } },
} satisfies Prisma.JobSelect;

type JobRow = {
  id: string;
  status: JobStatus;
  error_code: string | null;
  cost: number;
  created_at: Date;
  finished_at: Date | null;
  content: { job_type_code: string };
};

export function toJobListItemDto(row: JobRow): JobListItemDto {
  return {
    jobId: row.id,
    type: row.content.job_type_code,
    status: row.status,
    errorCode: row.error_code,
    cost: row.cost,
    createdAt: row.created_at.toISOString(),
    finishedAt: row.finished_at?.toISOString() ?? null,
  };
}

// The content's result may exist because another job with the same content
// completed; this job shows it only if this job completed too.
export function toJobDto(row: JobRow & { content: { result: string | null } }): JobDto {
  return {
    ...toJobListItemDto(row),
    result: row.status === JobStatus.completed ? row.content.result : null,
  };
}
