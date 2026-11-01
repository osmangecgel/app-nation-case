import { Logger } from '@nestjs/common';
import pg from 'pg';
import { loadScriptEnv } from '#core/config/script-env.ts';
import { contentHash, normalizeInput } from '#shared/job-content.ts';
import { uuidV7 } from '#shared/uuid-v7.ts';

// One user with 500,000 finished jobs, for EXPLAIN ANALYZE of the list query and
// for the CSV export memory check. Rerunning replaces the seeded data.
//
// Around it, 5,000 ordinary users with 100 jobs each. With a single user in the
// table every row matches its filter, and the planner may choose a plan (a
// backwards scan of the primary key) that only works because of that; with
// other users present, EXPLAIN shows the plan production would get.
//
// Only finished jobs (completed or failed) are created: queued or processing
// rows would be picked up by the reconciler and sent to the provider. Every
// job gets its ledger entries, so every balance matches the ledger.

const SEED_USER_ID = 'seed-user';
const JOB_COUNT = 500_000;
const BACKGROUND_USER_PREFIX = 'seed-user-bg-';
const BACKGROUND_USER_COUNT = 5_000;
const BACKGROUND_JOBS_PER_USER = 100;
const CONTENT_COUNT = 50_000;
// Contents that only failed jobs point to; they never got a result.
const FAILED_CONTENT_COUNT = 4_000;
const COMPLETED_CONTENT_COUNT = CONTENT_COUNT - FAILED_CONTENT_COUNT;
// Every 12th job failed, about 8%.
const FAILED_EVERY = 12;
const FINAL_BALANCE = 1_000;
const HISTORY_MS = 180 * 24 * 60 * 60 * 1000;
const JOB_DURATION_MS = 1_000;
const BATCH_SIZE = 5_000;
const JOB_TYPES = ['summary', 'translate'] as const;
const RESULT_PREFIX = { summary: 'Özet: ', translate: 'Çeviri: ' } as const;
const FAILURES = [
  { errorCode: 'provider_rejected', attemptCount: 1 },
  { errorCode: 'provider_timeout', attemptCount: 3 },
  { errorCode: 'provider_unavailable', attemptCount: 3 },
] as const;

const SeedLogEvent = {
  SEED_STARTED: 'SEED_STARTED',
  SEED_PROGRESS: 'SEED_PROGRESS',
  SEED_FINISHED: 'SEED_FINISHED',
} as const;

type JobTypeCode = (typeof JOB_TYPES)[number];

type Route = { cost: number; promptVersion: string; providerCode: string; modelVersion: string };

type SeedContent = { id: string; jobTypeCode: JobTypeCode; hashHex: string; input: string; result: string | null };

// A run of jobs spread over the history window: the seed user's, or the
// background users' taking turns.
type JobStream = { userIds: string[]; jobCount: number };

type SeedJob = {
  id: string;
  userId: string;
  content: SeedContent;
  route: Route;
  failure: (typeof FAILURES)[number] | null;
  resultSource: 'provider' | 'cache' | null;
  createdMs: number;
};

const logger = new Logger('Seed');

async function loadRoutes(client: pg.Client): Promise<Record<JobTypeCode, Route>> {
  const { rows } = await client.query<Route & { code: JobTypeCode }>(
    `SELECT DISTINCT ON (t.code)
            t.code, t.cost, t.prompt_version AS "promptVersion",
            r.job_provider_code AS "providerCode", r.model_version AS "modelVersion"
       FROM job_types t
       JOIN job_type_routes r ON r.job_type_code = t.code AND r.is_enabled
      WHERE t.code = ANY($1)
      ORDER BY t.code, r.weight DESC`,
    [JOB_TYPES],
  );
  const routeOf = (code: JobTypeCode): Route => {
    const route = rows.find((row) => row.code === code);
    if (!route) {
      throw new Error(`Job type ${code} has no enabled route. Run the migrations first.`);
    }
    return route;
  };
  return { summary: routeOf('summary'), translate: routeOf('translate') };
}

const backgroundUserIds = Array.from(
  { length: BACKGROUND_USER_COUNT },
  (_, index) => `${BACKGROUND_USER_PREFIX}${String(index + 1).padStart(4, '0')}`,
);
const seededUserIds = [SEED_USER_ID, ...backgroundUserIds];

async function deletePreviousSeed(client: pg.Client): Promise<void> {
  const users = [seededUserIds];
  await client.query('DELETE FROM user_credit_ledger WHERE user_id = ANY($1)', users);
  await client.query('DELETE FROM job_idempotency_keys WHERE user_id = ANY($1)', users);
  await client.query(
    'DELETE FROM job_outbox_messages WHERE job_id IN (SELECT id FROM jobs WHERE user_id = ANY($1))',
    users,
  );
  await client.query('DELETE FROM jobs WHERE user_id = ANY($1)', users);
  // Contents no other job points to; contents shared with real users stay.
  await client.query(
    'DELETE FROM job_contents c WHERE NOT EXISTS (SELECT 1 FROM jobs j WHERE j.job_content_id = c.id)',
  );
  await client.query('DELETE FROM users WHERE id = ANY($1)', users);
}

async function insertUsers(client: pg.Client): Promise<void> {
  await client.query('INSERT INTO users (id, updated_at) SELECT id, now() FROM unnest($1::varchar[]) AS u(id)', [
    seededUserIds,
  ]);
}

function buildContents(routes: Record<JobTypeCode, Route>, createdMs: number): SeedContent[] {
  return Array.from({ length: CONTENT_COUNT }, (_, index) => {
    const jobTypeCode = JOB_TYPES[index % JOB_TYPES.length];
    const input = `Seed metni ${index}`;
    const normalizedInput = normalizeInput(input);
    const { promptVersion, providerCode, modelVersion } = routes[jobTypeCode];
    const hash = contentHash({ jobTypeCode, promptVersion, providerCode, modelVersion, normalizedInput });
    const hasResult = index < COMPLETED_CONTENT_COUNT;
    return {
      id: uuidV7(createdMs),
      jobTypeCode,
      hashHex: hash.toString('hex'),
      input,
      result: hasResult ? `${RESULT_PREFIX[jobTypeCode]}${normalizedInput}` : null,
    };
  });
}

async function insertContents(client: pg.Client, contents: SeedContent[], createdAt: Date): Promise<void> {
  for (let start = 0; start < contents.length; start += BATCH_SIZE) {
    const batch = contents.slice(start, start + BATCH_SIZE);
    await client.query(
      `INSERT INTO job_contents (id, job_type_code, content_hash, input, result, result_at, created_at, updated_at)
       SELECT id, job_type_code, decode(hash_hex, 'hex'), input, result,
              CASE WHEN result IS NULL THEN NULL ELSE $6::timestamptz END, $6, $6
         FROM unnest($1::uuid[], $2::varchar[], $3::text[], $4::text[], $5::text[])
           AS c(id, job_type_code, hash_hex, input, result)`,
      [
        batch.map((content) => content.id),
        batch.map((content) => content.jobTypeCode),
        batch.map((content) => content.hashHex),
        batch.map((content) => content.input),
        batch.map((content) => content.result),
        createdAt,
      ],
    );
  }
}

// Jobs are spread evenly over the history window, oldest first, so their
// UUID v7 ids sort the same way as created_at.
function buildJob(
  stream: JobStream,
  index: number,
  contents: SeedContent[],
  routes: Record<JobTypeCode, Route>,
  historyStartMs: number,
  usedContents: Set<string>,
): SeedJob {
  const createdMs = historyStartMs + Math.floor((index * HISTORY_MS) / stream.jobCount);
  const failed = index % FAILED_EVERY === 0;
  const content = failed
    ? contents[COMPLETED_CONTENT_COUNT + (index % FAILED_CONTENT_COUNT)]
    : contents[index % COMPLETED_CONTENT_COUNT];
  // The first job with a content called the provider; later ones were served from the cache.
  const firstUse = !usedContents.has(content.id);
  if (!failed) {
    usedContents.add(content.id);
  }
  return {
    id: uuidV7(createdMs),
    userId: stream.userIds[index % stream.userIds.length],
    content,
    route: routes[content.jobTypeCode],
    failure: failed ? FAILURES[index % FAILURES.length] : null,
    resultSource: failed ? null : firstUse ? 'provider' : 'cache',
    createdMs,
  };
}

async function insertJobs(client: pg.Client, jobs: SeedJob[]): Promise<void> {
  await client.query(
    `INSERT INTO jobs (id, user_id, job_content_id, job_provider_code, model_version, status, cost,
                      error_code, result_source, attempt_count, run_after, dispatched_at, dispatch_count,
                      created_at, updated_at, finished_at)
     SELECT id, user_id, job_content_id, job_provider_code, model_version, status, cost,
            error_code, result_source, attempt_count, created_at, created_at, 1,
            created_at, finished_at, finished_at
       FROM unnest($1::varchar[], $2::uuid[], $3::uuid[], $4::varchar[], $5::varchar[], $6::job_status[], $7::int[],
                   $8::varchar[], $9::job_result_source[], $10::int[], $11::timestamptz[], $12::timestamptz[])
         AS j(user_id, id, job_content_id, job_provider_code, model_version, status, cost,
              error_code, result_source, attempt_count, created_at, finished_at)`,
    [
      jobs.map((job) => job.userId),
      jobs.map((job) => job.id),
      jobs.map((job) => job.content.id),
      jobs.map((job) => job.route.providerCode),
      jobs.map((job) => job.route.modelVersion),
      jobs.map((job) => (job.failure ? 'failed' : 'completed')),
      jobs.map((job) => job.route.cost),
      jobs.map((job) => job.failure?.errorCode ?? null),
      jobs.map((job) => job.resultSource),
      jobs.map((job) => job.failure?.attemptCount ?? (job.resultSource === 'provider' ? 1 : 0)),
      jobs.map((job) => new Date(job.createdMs)),
      jobs.map((job) => new Date(job.createdMs + JOB_DURATION_MS)),
    ],
  );
}

// Each job reserves its cost when created and captures or releases it when it finishes.
async function insertJobLedger(client: pg.Client, jobs: SeedJob[]): Promise<void> {
  const entries = jobs.flatMap((job) => [
    {
      id: uuidV7(job.createdMs),
      userId: job.userId,
      jobId: job.id,
      type: 'reserve',
      amount: job.route.cost,
      atMs: job.createdMs,
    },
    {
      id: uuidV7(job.createdMs + JOB_DURATION_MS),
      userId: job.userId,
      jobId: job.id,
      type: job.failure ? 'release' : 'capture',
      amount: job.route.cost,
      atMs: job.createdMs + JOB_DURATION_MS,
    },
  ]);
  await client.query(
    `INSERT INTO user_credit_ledger (id, user_id, job_id, entry_type, amount, created_at)
     SELECT id, user_id, job_id, entry_type, amount, created_at
       FROM unnest($1::varchar[], $2::uuid[], $3::uuid[], $4::user_credit_entry_type[], $5::int[], $6::timestamptz[])
         AS l(user_id, id, job_id, entry_type, amount, created_at)`,
    [
      entries.map((entry) => entry.userId),
      entries.map((entry) => entry.id),
      entries.map((entry) => entry.jobId),
      entries.map((entry) => entry.type),
      entries.map((entry) => entry.amount),
      entries.map((entry) => new Date(entry.atMs)),
    ],
  );
}

// Adds the credits each user's jobs captured to `captured`, to size the opening grants.
async function insertStream(
  client: pg.Client,
  stream: JobStream,
  seedData: { contents: SeedContent[]; routes: Record<JobTypeCode, Route>; historyStartMs: number },
  usedContents: Set<string>,
  captured: Map<string, number>,
): Promise<void> {
  for (let start = 0; start < stream.jobCount; start += BATCH_SIZE) {
    const jobs = Array.from({ length: Math.min(BATCH_SIZE, stream.jobCount - start) }, (_, offset) =>
      buildJob(stream, start + offset, seedData.contents, seedData.routes, seedData.historyStartMs, usedContents),
    );
    await insertJobs(client, jobs);
    await insertJobLedger(client, jobs);
    for (const job of jobs.filter((candidate) => !candidate.failure)) {
      captured.set(job.userId, (captured.get(job.userId) ?? 0) + job.route.cost);
    }
    if ((start + BATCH_SIZE) % 100_000 === 0) {
      logger.log(SeedLogEvent.SEED_PROGRESS, { users: stream.userIds.length, jobs: start + BATCH_SIZE });
    }
  }
}

// The opening grant covers everything a user's jobs captured plus the final
// balance, so balance = grant - reserve + release holds for every user.
async function insertGrantsAndBalances(
  client: pg.Client,
  captured: Map<string, number>,
  historyStartMs: number,
): Promise<void> {
  const grantAt = new Date(historyStartMs - 60_000);
  await client.query(
    `INSERT INTO user_credit_ledger (id, user_id, entry_type, amount, created_at)
     SELECT id, user_id, 'grant', amount, $3 FROM unnest($1::varchar[], $2::int[], $4::uuid[]) AS g(user_id, amount, id)`,
    [
      seededUserIds,
      seededUserIds.map((userId) => (captured.get(userId) ?? 0) + FINAL_BALANCE),
      grantAt,
      seededUserIds.map(() => uuidV7(grantAt.getTime())),
    ],
  );
  await client.query('UPDATE users SET balance = $2, updated_at = now() WHERE id = ANY($1)', [
    seededUserIds,
    FINAL_BALANCE,
  ]);
}

// Every seeded user: the balance and the reservations match the ledger, and
// nothing is left reserved or counted as running, since every job is finished.
async function assertLedgerMatchesBalances(client: pg.Client): Promise<void> {
  const { rows } = await client.query<{ mismatched: number }>(
    `SELECT count(*)::int AS mismatched FROM (
       SELECT u.balance = sum(l.amount) FILTER (WHERE l.entry_type IN ('grant', 'release'))
                        - coalesce(sum(l.amount) FILTER (WHERE l.entry_type = 'reserve'), 0)
          AND coalesce(sum(l.amount) FILTER (WHERE l.entry_type = 'reserve'), 0)
            = coalesce(sum(l.amount) FILTER (WHERE l.entry_type IN ('capture', 'release')), 0)
          AND u.reserved = 0 AND u.active_job_count = 0 AS matches
         FROM users u JOIN user_credit_ledger l ON l.user_id = u.id
        WHERE u.id = ANY($1)
        GROUP BY u.id
     ) checked
     WHERE NOT matches`,
    [seededUserIds],
  );
  if (rows[0]?.mismatched !== 0) {
    throw new Error(`Seed failed: ${rows[0]?.mismatched} users do not match their ledger.`);
  }
}

async function seed(client: pg.Client): Promise<void> {
  const historyStartMs = Date.now() - HISTORY_MS;
  await client.query('BEGIN');
  try {
    const routes = await loadRoutes(client);
    await deletePreviousSeed(client);
    await insertUsers(client);
    const contents = buildContents(routes, historyStartMs);
    await insertContents(client, contents, new Date(historyStartMs));
    const seedData = { contents, routes, historyStartMs };
    const usedContents = new Set<string>();
    const captured = new Map<string, number>();
    await insertStream(client, { userIds: [SEED_USER_ID], jobCount: JOB_COUNT }, seedData, usedContents, captured);
    const background = { userIds: backgroundUserIds, jobCount: BACKGROUND_USER_COUNT * BACKGROUND_JOBS_PER_USER };
    await insertStream(client, background, seedData, usedContents, captured);
    await insertGrantsAndBalances(client, captured, historyStartMs);
    await assertLedgerMatchesBalances(client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
  // Fresh statistics, so EXPLAIN shows the plans the real data would get, and a
  // vacuum, as autovacuum would do in production: without it the first reads
  // of every page also write hint bits, and EXPLAIN measures that instead.
  await client.query('VACUUM (ANALYZE) users, jobs, job_contents, user_credit_ledger');
}

async function main(): Promise<void> {
  const client = new pg.Client({ connectionString: loadScriptEnv().DATABASE_URL });
  await client.connect();
  const startedAt = Date.now();
  logger.log(SeedLogEvent.SEED_STARTED, {
    userId: SEED_USER_ID,
    jobs: JOB_COUNT,
    backgroundUsers: BACKGROUND_USER_COUNT,
    backgroundJobs: BACKGROUND_USER_COUNT * BACKGROUND_JOBS_PER_USER,
    contents: CONTENT_COUNT,
  });
  try {
    await seed(client);
  } finally {
    await client.end();
  }
  logger.log(SeedLogEvent.SEED_FINISHED, { userId: SEED_USER_ID, durationMs: Date.now() - startedAt });
}

await main();
