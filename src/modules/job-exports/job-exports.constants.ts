// Rows read per query while writing an export: memory stays bounded and no
// database connection or transaction is held while waiting on the reader.
export const EXPORT_BATCH_SIZE = 1_000;

// Streamed export admission (EXPORT_MODE stream, and auto for small exports).
// A slot and the user's lock are leases in Redis, renewed while the export
// runs, so a crashed instance's slots free themselves.
export const EXPORT_SLOT_LEASE_MS = 30_000;
// A request waiting for a slot asks again after a random wait in this range,
// so waiting requests do not all ask at the same moment.
export const EXPORT_SLOT_POLL_MIN_MS = 100;
export const EXPORT_SLOT_POLL_MAX_MS = 500;
// Retry-After of a 429 for a streamed export.
export const EXPORT_RETRY_AFTER_SECONDS = 10;

// Background exports (EXPORT_MODE async, and auto for large exports).
// Retry-After of a 202 and of a status still in progress: how often to poll.
export const EXPORT_POLL_AFTER_SECONDS = 5;
// A ready file this recent is returned again instead of preparing a new one.
export const EXPORT_REUSE_WINDOW_MS = 5 * 60 * 1000;
export const EXPORT_MAX_ATTEMPTS = 3;
// A failed attempt is tried again after 2 s, then 4 s.
export const EXPORT_RETRY_BASE_DELAY_MS = 2_000;
// As for jobs: the wait before re-sending an unreceived dispatch doubles up to this.
export const EXPORT_MAX_REDISPATCH_WAIT_MS = 60 * 60 * 1000;
export const EXPORT_MAINTENANCE_BATCH_SIZE = 100;

// The jobs module documents these on GET /v1/jobs/export.csv, so they are
// here rather than in an errors file (ARCH-05).
export const JobExportErrorCode = {
  // The user already has a streamed export running.
  EXPORT_IN_PROGRESS: 'EXPORT_IN_PROGRESS',
  // Every streamed export slot stayed taken for EXPORT_ADMISSION_WAIT_MS.
  EXPORT_SLOTS_BUSY: 'EXPORT_SLOTS_BUSY',
  EXPORT_NOT_FOUND: 'EXPORT_NOT_FOUND',
  // The export is not ready yet, failed, was canceled or its file expired.
  EXPORT_FILE_NOT_FOUND: 'EXPORT_FILE_NOT_FOUND',
} as const;

export const ExportFailureCode = {
  // Every attempt failed (the database or the file store).
  EXPORT_FAILED: 'export_failed',
  // The worker died during the last allowed attempt.
  WORKER_LOST: 'worker_lost',
} as const;

export const JobExportLogEvent = {
  JOB_EXPORT_STARTED: 'JOB_EXPORT_STARTED',
  JOB_EXPORT_FINISHED: 'JOB_EXPORT_FINISHED',
  JOB_EXPORT_ABORTED: 'JOB_EXPORT_ABORTED',
  JOB_EXPORT_FAILED: 'JOB_EXPORT_FAILED',
  EXPORT_SLOT_FALLBACK: 'EXPORT_SLOT_FALLBACK',
  EXPORT_REQUESTED: 'EXPORT_REQUESTED',
  EXPORT_STARTED: 'EXPORT_STARTED',
  EXPORT_READY: 'EXPORT_READY',
  EXPORT_RETRY_SCHEDULED: 'EXPORT_RETRY_SCHEDULED',
  EXPORT_FAILED: 'EXPORT_FAILED',
  EXPORT_RETURNED_TO_QUEUE: 'EXPORT_RETURNED_TO_QUEUE',
  EXPORT_LEASE_EXTEND_FAILED: 'EXPORT_LEASE_EXTEND_FAILED',
  EXPORT_LEASE_EXPIRED: 'EXPORT_LEASE_EXPIRED',
  EXPORT_REDISPATCHED: 'EXPORT_REDISPATCHED',
  EXPORT_EXPIRED: 'EXPORT_EXPIRED',
} as const;
