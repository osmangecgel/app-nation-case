import type { JobListItemDto } from '#modules/jobs/dto/job.dto.ts';

// RFC 4180: every record, the header included, ends with CRLF.
const RECORD_END = '\r\n';

export const JOB_CSV_HEADER = `job_id,type,status,cost,error_code,created_at,finished_at${RECORD_END}`;

// Characters a spreadsheet may treat as the start of a formula (CSV injection).
const FORMULA_START = /^[=+\-@\t\r]/;

// RFC 4180 quoting. The export holds no user text today, but a field that could
// start a formula is prefixed with ' so a spreadsheet shows it as text.
export function csvField(value: string | number | null): string {
  if (value === null) {
    return '';
  }
  const text = String(value);
  const safe = FORMULA_START.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function toJobCsvLine(job: JobListItemDto): string {
  const fields = [job.jobId, job.type, job.status, job.cost, job.errorCode, job.createdAt, job.finishedAt];
  return `${fields.map(csvField).join(',')}${RECORD_END}`;
}
