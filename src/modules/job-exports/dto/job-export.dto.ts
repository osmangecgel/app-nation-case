import { z } from 'zod';
import { JobExportStatus } from '#generated/prisma/enums.ts';

export const ExportIdParamsSchema = z.strictObject({
  id: z.string().meta({ description: 'Export id.', example: '0192f3a1-7c4e-7b2a-9d1f-3e5a8b6c2d10' }),
});

export type ExportIdParams = z.infer<typeof ExportIdParamsSchema>;

export const JobExportSchema = z
  .object({
    exportId: z.uuid().meta({ description: 'Id to poll the export with.' }),
    status: z.enum(JobExportStatus).meta({
      description: 'queued and processing: being prepared. ready: the file can be downloaded until expiresAt.',
      example: JobExportStatus.processing,
    }),
    rowCount: z.number().int().nullable().meta({ description: 'Jobs in the file, once ready.', example: null }),
    errorCode: z.string().nullable().meta({ description: 'Set when the export failed.', example: null }),
    createdAt: z.iso.datetime(),
    finishedAt: z.iso.datetime().nullable().meta({ description: 'Null while queued or processing.' }),
    expiresAt: z.iso.datetime().nullable().meta({ description: 'When the file is deleted; set once ready.' }),
  })
  .meta({ id: 'JobExport' });

export type JobExportDto = z.infer<typeof JobExportSchema>;

export type JobExportRow = {
  id: string;
  status: JobExportStatus;
  row_count: number | null;
  error_code: string | null;
  created_at: Date;
  finished_at: Date | null;
  expires_at: Date | null;
};

export function toJobExportDto(row: JobExportRow): JobExportDto {
  return {
    exportId: row.id,
    status: row.status,
    rowCount: row.row_count,
    errorCode: row.error_code,
    createdAt: row.created_at.toISOString(),
    finishedAt: row.finished_at?.toISOString() ?? null,
    expiresAt: row.expires_at?.toISOString() ?? null,
  };
}
