export const NodeEnv = {
  DEVELOPMENT: 'development',
  TEST: 'test',
  PRODUCTION: 'production',
} as const;
export type NodeEnv = (typeof NodeEnv)[keyof typeof NodeEnv];

export const LogFormat = {
  PRETTY: 'pretty',
  JSON: 'json',
} as const;
export type LogFormat = (typeof LogFormat)[keyof typeof LogFormat];

// Ordered from least to most severe; LOG_LEVEL enables its level and everything after it.
export const LogLevel = {
  VERBOSE: 'verbose',
  DEBUG: 'debug',
  LOG: 'log',
  WARN: 'warn',
  ERROR: 'error',
  FATAL: 'fatal',
} as const;
export type LogLevel = (typeof LogLevel)[keyof typeof LogLevel];

// Queue brokers this build has an adapter for (src/infra/queue/<driver>/).
export const QueueDriver = {
  KAFKA: 'kafka',
} as const;
export type QueueDriver = (typeof QueueDriver)[keyof typeof QueueDriver];

// How GET /v1/jobs/export.csv answers: stream the file now, prepare it in the
// background (202 and an export to poll), or decide by the user's job count.
export const ExportMode = {
  STREAM: 'stream',
  ASYNC: 'async',
  AUTO: 'auto',
} as const;
export type ExportMode = (typeof ExportMode)[keyof typeof ExportMode];
