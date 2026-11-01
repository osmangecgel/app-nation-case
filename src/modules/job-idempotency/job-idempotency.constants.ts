// The case: "Keys are valid for 24 hours."
export const IDEMPOTENCY_KEY_TTL_SECONDS = 24 * 60 * 60;
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
export const IDEMPOTENCY_KEY_MAX_LENGTH = 255;

// A claim can lose a race to an expiring or concurrently removed key; it is
// retried with a fresh snapshot before giving up.
export const MAX_KEY_CLAIM_ATTEMPTS = 3;

export const JobIdempotencyErrorCode = {
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
} as const;

// Expired keys are deleted in small batches so cleanup never holds long locks.
export const KEY_CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
export const KEY_CLEANUP_BATCH_SIZE = 1_000;

export const JobIdempotencyLogEvent = {
  IDEMPOTENCY_KEYS_CLEANED_UP: 'IDEMPOTENCY_KEYS_CLEANED_UP',
  IDEMPOTENCY_KEY_CLEANUP_FAILED: 'IDEMPOTENCY_KEY_CLEANUP_FAILED',
} as const;
