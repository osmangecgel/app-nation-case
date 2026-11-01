// Kafka topic the relay publishes new and retried jobs to.
export const JOB_DISPATCH_TOPIC = 'jobs.process';
// Background CSV exports: their own topic, so exports never wait behind jobs.
export const EXPORT_DISPATCH_TOPIC = 'exports.process';

export const OUTBOX_RELAY_BATCH_SIZE = 500;
// Upper bound of one relay transaction: Kafka's send timeout plus the database work.
export const OUTBOX_RELAY_TIMEOUT_MS = 15_000;

// Sent rows are kept this long, then deleted in batches.
export const OUTBOX_RETENTION_MS = 60 * 60 * 1000;
export const OUTBOX_CLEANUP_INTERVAL_MS = 60 * 1000;
export const OUTBOX_CLEANUP_BATCH_SIZE = 1_000;

export const OutboxLogEvent = {
  OUTBOX_RELAY_FAILED: 'OUTBOX_RELAY_FAILED',
  OUTBOX_CLEANED_UP: 'OUTBOX_CLEANED_UP',
} as const;
