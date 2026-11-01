// Error codes a failed job carries; the API returns them as errorCode.
export const JobFailureCode = {
  // The provider rejected the input; retrying cannot help.
  PROVIDER_REJECTED: 'provider_rejected',
  // Every attempt timed out.
  PROVIDER_TIMEOUT: 'provider_timeout',
  // Every attempt failed with a transient error.
  PROVIDER_UNAVAILABLE: 'provider_unavailable',
  // The provider answered with something unusable (e.g. empty) on every attempt.
  PROVIDER_INVALID_RESPONSE: 'provider_invalid_response',
  // No adapter for the job's provider in this build.
  PROVIDER_NOT_CONFIGURED: 'provider_not_configured',
  // The job's type is no longer in the configuration.
  JOB_TYPE_UNAVAILABLE: 'job_type_unavailable',
  // The worker died during the last allowed attempt.
  WORKER_LOST: 'worker_lost',
} as const;

// Transient failures are retried after 1 s, then 2 s, ... plus up to this much
// at random, so jobs that failed together do not all retry in the same instant.
export const RETRY_BASE_DELAY_MS = 1_000;
export const RETRY_JITTER_MS = 250;

// Writing the outcome is retried briefly on a database error, so a short
// outage does not throw away a provider answer that has already been paid for.
export const SETTLE_ATTEMPTS = 3;
export const SETTLE_RETRY_DELAY_MS = 200;

// A worker waiting for another worker's provider call checks this often.
export const CALL_LOCK_POLL_MS = 100;
// The call lock outlives the provider timeout by this much, so it is never
// released by expiry while its holder's call is still allowed to run.
export const CALL_LOCK_MARGIN_MS = 5_000;

// Longest result accepted from a provider; longer answers are treated as invalid.
export const MAX_RESULT_CHARS = 1_000_000;

// The longest wait before a job whose message no worker received is sent
// again; the wait doubles up to it from RECONCILER_STALE_QUEUED_MS.
export const MAX_REDISPATCH_WAIT_MS = 60 * 60 * 1000;
export const RECONCILER_BATCH_SIZE = 100;

export const JobWorkerLogEvent = {
  JOB_CLAIMED: 'JOB_CLAIMED',
  JOB_CLAIM_SKIPPED: 'JOB_CLAIM_SKIPPED',
  JOB_COMPLETED: 'JOB_COMPLETED',
  JOB_FAILED: 'JOB_FAILED',
  JOB_RETRY_SCHEDULED: 'JOB_RETRY_SCHEDULED',
  JOB_RETURNED_TO_QUEUE: 'JOB_RETURNED_TO_QUEUE',
  JOB_LEASE_LOST: 'JOB_LEASE_LOST',
  JOB_LEASE_EXTEND_FAILED: 'JOB_LEASE_EXTEND_FAILED',
  JOB_SETTLE_FAILED: 'JOB_SETTLE_FAILED',
  JOB_PROCESSING_FAILED: 'JOB_PROCESSING_FAILED',
  PROVIDER_ERROR_UNEXPECTED: 'PROVIDER_ERROR_UNEXPECTED',
  JOB_LEASE_EXPIRED: 'JOB_LEASE_EXPIRED',
  JOB_REDISPATCHED: 'JOB_REDISPATCHED',
  RECONCILER_FAILED: 'RECONCILER_FAILED',
  MESSAGE_INVALID: 'MESSAGE_INVALID',
  WORKER_STARTED: 'WORKER_STARTED',
  WORKER_STOPPING: 'WORKER_STOPPING',
  WORKER_STOPPED: 'WORKER_STOPPED',
} as const;
