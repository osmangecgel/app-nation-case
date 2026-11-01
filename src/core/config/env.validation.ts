import { z } from 'zod';
import { ExportMode, LogFormat, LogLevel, NodeEnv, QueueDriver } from './env.constants.ts';

const envSchema = z
  .object({
    NODE_ENV: z.enum(NodeEnv).default(NodeEnv.DEVELOPMENT),
    PORT: z.coerce.number().int().positive().default(13400),
    DATABASE_URL: z.url(),
    CACHE_REDIS_URL: z.url(),
    LOG_LEVEL: z.enum(LogLevel).default(LogLevel.LOG),
    LOG_FORMAT: z.enum(LogFormat).optional(),
    LOG_HTTP_BODIES: z.stringbool().default(false),
    LOG_DB_QUERIES: z.stringbool().default(false),
    ERROR_INCLUDE_STACK: z.stringbool().default(false),
    RATE_LIMIT_TTL_SECONDS: z.coerce.number().int().positive().default(60),
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(1000),
    // Number of reverse proxies in front of the app; 0 trusts none (API-09).
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(0),
    // Unfinished jobs a user may have at once, so one client cannot fill the queue.
    MAX_ACTIVE_JOBS_PER_USER: z.coerce.number().int().positive().default(50),
    // How often job types, providers and routes are reloaded from the database.
    JOB_CONFIG_REFRESH_MS: z.coerce.number().int().positive().default(30_000),
    // Which adapter carries job messages (src/infra/queue/<driver>/).
    QUEUE_DRIVER: z.enum(QueueDriver).default(QueueDriver.KAFKA),
    // AI provider adapters to load, comma-separated. job_providers.adapter picks
    // among them per job; a job whose adapter is not loaded fails with
    // provider_not_configured.
    AI_PROVIDER_ADAPTERS: z
      .string()
      .default('fake')
      .transform((value) => value.split(',').map((adapter) => adapter.trim()))
      .pipe(z.array(z.string().min(1)).min(1)),
    // CSV export. stream: GET /v1/jobs/export.csv streams the file (the case's
    // behaviour); async: it answers 202 with an export prepared in the
    // background; auto: streams up to EXPORT_STREAM_MAX_ROWS jobs, else async.
    EXPORT_MODE: z.enum(ExportMode).default(ExportMode.STREAM),
    EXPORT_STREAM_MAX_ROWS: z.coerce.number().int().positive().default(10_000),
    // Streamed exports running at once across every API instance (a lease in
    // Redis), and per instance while Redis is unavailable.
    EXPORT_MAX_CONCURRENT: z.coerce.number().int().positive().default(200),
    EXPORT_FALLBACK_MAX_CONCURRENT: z.coerce.number().int().positive().default(20),
    // How long a streamed export waits for a free slot before a 429.
    EXPORT_ADMISSION_WAIT_MS: z.coerce.number().int().min(0).default(10_000),
    // Background exports one worker prepares at once.
    EXPORT_WORKER_CONCURRENCY: z.coerce.number().int().positive().default(2),
    // How long a prepared file can be downloaded.
    EXPORT_FILE_TTL_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(24 * 60 * 60 * 1000),
    // Where the local file store keeps prepared files (shared by API and worker).
    EXPORT_FILES_DIR: z.string().min(1).default('./data/exports'),
    // Comma-separated host:port list. Only the worker talks to Kafka.
    KAFKA_BROKERS: z.string().min(1).default('localhost:19092'),
    KAFKA_CLIENT_ID: z.string().min(1).default('app-nation-case'),
    // Provider calls one worker makes at once (the case: 4, configurable).
    WORKER_PROVIDER_CONCURRENCY: z.coerce.number().int().positive().default(4),
    // Jobs one worker holds at once, from all its partitions. A job waiting for
    // a provider permit is not claimed yet and costs no database work, so this
    // bounds memory, not the provider: it is far above WORKER_PROVIDER_CONCURRENCY,
    // and jobs whose result is known do not wait behind those waiting for a call.
    WORKER_JOB_CONCURRENCY: z.coerce.number().int().positive().default(500),
    // A claimed job belongs to its worker for this long; the worker extends it
    // every WORKER_HEARTBEAT_MS. A dead worker's job is taken over after it expires.
    WORKER_LEASE_MS: z.coerce.number().int().positive().default(15_000),
    WORKER_HEARTBEAT_MS: z.coerce.number().int().positive().default(5_000),
    // On SIGTERM, how long jobs in flight may run before they are put back in the queue.
    WORKER_SHUTDOWN_GRACE_MS: z.coerce.number().int().positive().default(25_000),
    OUTBOX_RELAY_INTERVAL_MS: z.coerce.number().int().positive().default(200),
    RECONCILER_INTERVAL_MS: z.coerce.number().int().positive().default(5_000),
    // A queued job not picked up for this long is dispatched again.
    RECONCILER_STALE_QUEUED_MS: z.coerce.number().int().positive().default(120_000),
  })
  .refine((env) => env.WORKER_HEARTBEAT_MS < env.WORKER_LEASE_MS, {
    path: ['WORKER_HEARTBEAT_MS'],
    message: 'Must be shorter than WORKER_LEASE_MS, or leases expire between heartbeats.',
  })
  .refine((env) => !(env.NODE_ENV === NodeEnv.PRODUCTION && env.ERROR_INCLUDE_STACK), {
    path: ['ERROR_INCLUDE_STACK'],
    message: 'Must be false in production (ERR-08).',
  })
  .transform((env) => ({
    ...env,
    LOG_FORMAT: env.LOG_FORMAT ?? (env.NODE_ENV === NodeEnv.DEVELOPMENT ? LogFormat.PRETTY : LogFormat.JSON),
  }));

export type Env = z.output<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const result = envSchema.safeParse(config);
  if (!result.success) {
    throw new Error(`Invalid environment variables:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
