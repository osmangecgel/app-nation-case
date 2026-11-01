# Queue Standards

This document defines the rules for sending jobs to the worker through the queue and for processing them in the worker. Each rule has an ID (such as `QUEUE-01`). Use this ID to refer to a rule in code review.

The broker is Kafka 4.1 (KRaft). The client library is `@confluentinc/kafka-javascript`. The API (`src/main.ts`) never connects to Kafka: it writes the job and the outbox row to the database. Only the worker process (`src/worker.ts`) uses Kafka.

To change a rule, open a PR that changes this file and write the reason in the PR description.

> **Status (1 November 2026):** The rules describe the behavior in the code. The queue port is `src/infra/queue/queue.ts` and the Kafka adapter is under `src/infra/queue/kafka`, the outbox under `src/modules/job-outbox`, the worker under `src/modules/job-worker`. Two kinds of work use the queue: jobs (`jobs.process`) and background CSV exports (`exports.process`, `API_STANDARDS.md`, API-16). The rules are written for jobs; where exports differ, the rule says so. Known gaps are in the "Pending proposals" section.

## Rule summary

| ID | Rule |
|---|---|
| QUEUE-01 | Modules depend only on the queue port (`src/infra/queue/queue.ts`). A broker is an adapter folder under `src/infra/queue/`, chosen by `QUEUE_DRIVER`; its library is imported only there. |
| QUEUE-02 | Delays and scheduling are kept in the database, not in the broker (`not_before`, `run_after`). Retries do not wait in memory. |
| QUEUE-03 | Removed: every message is a command that takes work (a job or an export) to the worker. A rule will be written when event messages are needed. |
| QUEUE-04 | Topic names use the `<domain>.<action>` format. The dead-letter topic is named with a `.dlq` suffix. Topics are created explicitly. |
| QUEUE-05 | The message value is snake_case JSON and is validated with zod. Tracing data is in the header, the ordering key is in the key. |
| QUEUE-06 | A message carries only an ID. The job's state and content are in the database. |
| QUEUE-07 | A change to the message format keeps reading old messages. An incompatible change is made with a new topic. |
| QUEUE-08 | A message that results from a database write is written to the outbox table in the same transaction as the data. The relay sends it to Kafka. |
| QUEUE-09 | The handler produces the correct result even if it processes the same message twice. The protection is the job's state and a conditional update. |
| QUEUE-10 | The handler does not rely on message order. Even messages in the same partition are processed side by side. |
| QUEUE-11 | A retry is an attempt of the job, not of the message. The attempt count and time limit come from the job type, the backoff is exponential. |
| QUEUE-12 | Only a message that points to no job goes to the dead-letter topic. A job whose attempts run out becomes `failed`. |
| QUEUE-13 | Removed: the queue is in Kafka. Redis is used only as a cache, there is no separate queue Redis. |
| QUEUE-14 | Periodic jobs run in every worker. Row locks, not a distributed lock, prevent two workers from doing the same work. |
| QUEUE-15 | A periodic job's result does not change if it runs twice or at the same time. Each change checks its own condition again. |
| QUEUE-16 | Time comparisons use the database clock (`now()`). |
| QUEUE-17 | Sent outbox rows and expired idempotency keys are deleted in batches. |
| QUEUE-18 | The job's history and state are in the `jobs` table, its result text in `job_contents`. The outbox is only for delivery. |
| QUEUE-19 | Offsets are committed in order, and only when the message's job is done. Delivery is at-least-once, memory does not grow with queue length. |
| QUEUE-20 | A job is claimed right before work on it starts: with a lease duration, a `lock_token` and a heartbeat. |
| QUEUE-21 | On SIGTERM the worker takes no new jobs, and finishes its jobs or gives them back to the queue. |
| QUEUE-22 | Every accepted job ends as `completed` or `failed`. The reconciler guarantees this. |
| QUEUE-23 | Provider calls are limited per worker. One call is made for the same content. |

## Architecture

### QUEUE-01: Modules depend on the queue port, a broker is an adapter

**Rule:** The queue has a port, `src/infra/queue/queue.ts`: the types `QueueMessage` and `ReceivedMessage`, the abstract classes `QueuePublisher` and `QueueConsumerFactory`, and the `QueueConsumer` interface. Modules import only this file and `QueueModule.register()`. A broker is an adapter folder under `src/infra/queue/<driver>/`; its library is imported only there, and its module binds the two abstract classes to its own classes. `QueueModule` loads the one driver `QUEUE_DRIVER` names (default `kafka`), so the others open no connections. `QueueModule` is imported only in the worker's modules. The API writes to the outbox (`JobOutboxModule`) and does not load the relay (`JobOutboxRelayModule`).

Every adapter keeps the contract written in `queue.ts`, because the worker's correctness relies on it:

- **Publish:** `publish` resolves only after the broker has stored every message; otherwise it rejects, and the outbox row stays unsent.
- **Delivery is at-least-once:** a message is acknowledged only after its handler returned `true`. `false` or a rejection means it is delivered again, after a pause. A message the consumer was handling when it died is delivered again.
- **Order is not promised:** handlers tolerate duplicates and any order (QUEUE-10). The message `key` groups messages of the same content on one consumer where the broker can (Kafka partitions); a broker that cannot ignores it, and only the number of provider calls changes, not the result.
- **`pause` and `stop`:** `pause` stops starting new messages, `stop` leaves the group so unacknowledged messages go to other workers (QUEUE-21).
- **`source`:** where the broker kept the message (Kafka: partition and offset), for logs and the dead letter headers.

**Why:** The worker's correctness does not come from the broker: a message only names a job, and the job's state, the outbox and the reconciler are in PostgreSQL. So the broker is replaceable, and keeping it behind a port makes that a matter of one folder. The hard Kafka parts, such as offset commit, rebalance and prefetch, stay in that folder and are tested there (`kafka-queue-consumer.spec.ts`, `partition-progress.spec.ts`). The API not connecting to the broker is an extra safeguard: even if it is down, the API keeps accepting jobs, and the jobs wait in the outbox.

**Structure:**

```
src/infra/queue/
  queue.ts                       the port: types, QueuePublisher, QueueConsumer, QueueConsumerFactory
  queue.module.ts                QueueModule.register(): loads the driver QUEUE_DRIVER names
  kafka/                         the Kafka adapter
    kafka.client.ts              builds the Kafka client
    kafka-queue-publisher.ts     KafkaQueuePublisher
    kafka-queue-consumer.ts      KafkaQueueConsumer, KafkaQueueConsumerFactory
    partition-progress.ts        per-partition commit tracking
    kafka-queue.module.ts        binds the port to the Kafka classes
```

Adding a broker (BullMQ, RabbitMQ): a new `src/infra/queue/<driver>/` folder that implements the port and keeps the contract above, one entry in `QUEUE_DRIVERS` (`queue.module.ts`), one value in `QueueDriver` (`env.constants.ts`), its connection settings in `env.validation.ts`, and its service in `docker-compose.yml`. No module changes. `docs/design.md` (section 15) lists what changes in behaviour.

**Check:** Lint: a module that imports `#infra/queue/<driver>/**` fails (`.oxlintrc.json`). Code review: a broker library is not imported outside its driver folder; `src/app.module.ts` does not import `QueueModule`.

### QUEUE-02: Delay is kept in the database

**Rule:** If a job must be processed at a later time (retry backoff), that time is written to the database: the job's `run_after` column and the outbox row's `not_before` column. The relay does not send a row whose `not_before` time has not come. The worker does not `sleep` in memory during the wait and does not hold the message.

**Why:** Kafka does not support delayed delivery. Waiting in memory causes two problems: if the worker crashes, the waiting job is lost, and each waiting job takes space in the worker's memory. With the delay in the database, a worker crash loses nothing and the number of waiting jobs does not affect worker memory.

**Example:** On a transient error, `job-settlement.service.ts` sets the job to `queued` with `run_after` in the same transaction and writes a new outbox row with `notBefore: runAfter`.

**Check:** Code review. The worker has no `sleep` that waits for a retry.

## Message definition

### QUEUE-04: Topic names and creation

**Rule:** A topic name uses the `<domain>.<action>` format (`jobs.process`, `exports.process`). The topic for unreadable messages is named by adding `.dlq` to the end of the same name (`jobs.process.dlq`). Topics are created in the `kafka-init` service in `docker-compose.yml`, with the partition count written explicitly. Automatic topic creation is disabled on the broker (`KAFKA_AUTO_CREATE_TOPICS_ENABLE: 'false'`). Topic names are constants in the module's `.constants.ts` file (`JOB_DISPATCH_TOPIC`, `EXPORT_DISPATCH_TOPIC`).

**Why:** The partition count is the upper limit on the number of workers that can share a topic at the same time, and increasing it later changes the key-to-partition mapping. So it is chosen on purpose. For `jobs.process` it is 12; for `exports.process` 6, as exports are few and long, and each worker runs at most `EXPORT_WORKER_CONCURRENCY` (default 2) of them. If automatic creation is enabled, a misspelled topic name is silently created with default settings and messages go to a place nobody reads.

**Check:** Code review. A new topic is not used before it is added to `kafka-init`.

### QUEUE-05: Message format

**Rule:** A message has three parts:

| Part | Content | Why |
|---|---|---|
| Value | snake_case JSON: `{ "job_id": "<uuid>" }`, or `{ "export_id": "<uuid>" }` on `exports.process` | The job or export ID. The worker validates it with zod when reading. |
| Key | Hash of the content (`message_key`); the export ID for exports | Jobs with the same content go to the same partition, and so to the same worker, and share a single provider call (QUEUE-23). Exports have nothing to share, so their key only spreads them over the partitions. |
| Header | `request_id` | The ID of the API request that created the job. The worker writes it as `requestId` on every log line of this job (LOG-02). |

Message fields are snake_case, log fields are camelCase (`job_id` in the message, `jobId` in the log). A message that fails validation is handled according to QUEUE-12.

**Why:** With tracing data in the header, the message value describes only the job itself, and more tracing data can be added without touching the schema. The key is Kafka's unit of ordering and distribution. Here it is used not for order, but to gather the same content on a single worker.

**Check:** `JobDispatchSchema` in `src/modules/job-outbox/messages/job-dispatch.message.ts`. The relay builds the message with `toDispatchMessage`, and the consumers read it with `jobIdOf` or `exportIdOf` (value) and `requestIdOf` (header).

### QUEUE-06: A message carries only an ID

**Rule:** A message carries the ID that is enough to find the job. The job's input, state, attempt count and price are not put in the message. The worker reads all of them from the database. Rule CACHE-08 in `CACHE_STANDARDS.md` also applies to messages.

**Why:** A message is a "look at this job" call, not the job itself. If the state were in the message, an old message for the same job would carry an old state, and a repeated or late message would lead to a wrong decision. With the state only in the database, duplicate and late messages are harmless (QUEUE-09, QUEUE-10). User input also does not stay on the broker disk for Kafka's retention period.

**Check:** Code review.

### QUEUE-07: The message format changes in a backward-compatible way

**Rule:** A new field can be added to the message value. The reading schema ignores unknown fields. Removing a field, or changing its name or type, is an incompatible change. An incompatible change is made with a new topic: the worker reads both topics for a while, and the old topic is removed once it is empty.

**Why:** During a deploy, the topic contains messages written by old code, and some workers are not yet updated. An incompatible format sends unreadable messages to the dead-letter topic. Nothing is lost permanently (the reconciler sends the job again, QUEUE-22), but jobs are delayed. The method is the same as rule DB-10 in `DATABASE_STANDARDS.md`.

**Check:** Code review.

## Sending

### QUEUE-08: The message is written to the outbox in the same transaction as the data

**Rule:** A message that results from a database change is not sent directly to Kafka. The message is written to the `job_outbox_messages` table with `JobOutboxService.enqueue`, in the same transaction as the change. This path is used when a job is created, when a retry is scheduled, when a job is given back to the queue, and when the reconciler sends a job again; the same four cases exist for an export (`JobOutboxService.enqueueExport`). An outbox row names exactly one of `job_id` and `export_id` (a CHECK constraint). The outbox table belongs to the `job-outbox` module (ARCH-06).

The relay (`JobOutboxRelayService`) runs in every worker. Every 200 ms (`OUTBOX_RELAY_INTERVAL_MS`) it locks due rows (`sent_at IS NULL AND not_before <= now()`) in batches of 500 with `FOR UPDATE SKIP LOCKED`, sends them to Kafka, and writes `sent_at` after Kafka acknowledges. If a full batch comes back, it takes the next one without waiting.

A message that is not the result of a database change can be sent directly with `QueuePublisher.publish`. Today the only example is moving a bad message to the `.dlq` topic.

**Why:** If the message is sent in a separate step after the data is written, and the process crashes or Kafka is unreachable between the two steps, the job is accepted and credits are reserved, but the job never reaches a worker. With the outbox, both are stored together or neither is. In the worst case the relay sends a row twice (Kafka acknowledged, it crashed before writing `sent_at`). This is harmless thanks to QUEUE-09. `SKIP LOCKED` prevents more than one relay from sending the same row at the same time, and the number of relays grows with the number of workers.

**Note:** The relay holds the row locks inside the transaction until Kafka's acknowledgment arrives. This is a deliberate deviation from DB-17 in `DATABASE_STANDARDS.md` (no external service calls inside a transaction). The duration is bounded by the producer's send limit (`SEND_TIMEOUT_MS`, 10 s) and the transaction limit (`OUTBOX_RELAY_TIMEOUT_MS`, 15 s). To avoid holding the lock, a separate "sending" lease would have to be added to the row. That means a new column and a new recovery path instead of a short-lived lock.

**Check:** Code review. `QueuePublisher.publish` is called inside `$transaction` only in the relay.

## Processing

### QUEUE-09: The handler is safe against duplicate messages

**Rule:** Kafka delivers a message at least once, and the outbox relay can send a row twice. Even if the worker receives the message for the same job twice, it processes the job once. The protection is done with the job's state, not with a separate "processed messages" table:

1. `findClaimable` checks the state: if the job is finished, is on another worker, or its retry time has not come, the message is treated as processed and skipped. Its only write records that a worker received a queued job (`dispatch_count = 0`, QUEUE-22); running it twice gives the same row.
2. The claim is a single conditional `UPDATE` (`claim`). Of two workers that take the same job, only one gets the row.
3. Every later change requires the worker's `lock_token`. A worker that has lost the job cannot change anything (QUEUE-20).

**Why:** A message only points to a job (QUEUE-06), so the question "was this message processed" becomes "what state is this job in", and the answer is already in the `jobs` table. A separate processed-messages table keeps the same information a second time, adds a write for each message, and also needs cleanup. Credits are captured in the same transaction as the job's result and with the same `lock_token` condition, so a duplicate message does not cause a double charge either.

**Check:** Code review (`job-lifecycle.service.ts`). The worker's changes (`complete`, `fail`, `scheduleRetry`, `returnToQueue`, `extendLease`) require the `lock_token` and `status = 'processing'` in the `WHERE` clause. The claim (`claim`) and the reconciler's changes (`requeueExpired`, `redispatch`, `failStuck`) have no token to check: they check the state and lease condition again instead (`CLAIMABLE`, `locked_until < now()`), and the reconciler also holds the row with `FOR UPDATE SKIP LOCKED` in the same transaction.

### QUEUE-10: The handler does not rely on order

**Rule:** The handler does not assume messages are processed in the order they were sent. Messages in the same partition are also processed side by side (QUEUE-19). The decision is always made from the job's current state in the database.

**Why:** Waiting for order within a partition makes one slow message (a provider call heading for a timeout) hold up all the messages behind it, and total throughput is limited by the partition count. Jobs are independent of each other, so order is not needed. A late message (for example, a job the reconciler sent again that has already finished) is skipped at the state check.

**Check:** Code review.

### QUEUE-11: A retry is an attempt of the job

**Rule:** On a provider error, the attempt count and the time limit come from the job type's settings (`job_types.max_attempt_count`, `job_types.timeout_ms`; today 3 attempts and 10 s). The backoff between attempts is exponential: 1 s, 2 s, ... plus at most 250 ms of random extra (`RETRY_BASE_DELAY_MS`, `RETRY_JITTER_MS`). The backoff is written to the database according to QUEUE-02: `scheduleRetry` takes the delay and sets `run_after = now() + delay` with the database clock (QUEUE-16).

- Timeouts and unknown errors are transient and are retried.
- The provider rejecting the input is permanent, and the job becomes `failed` without waiting.
- An attempt cut short by shutdown is not counted (QUEUE-21).

Separately, when the handler throws an infrastructure error (the database is unreachable), `QueueConsumer` retries the message without limit, with a backoff that grows from 1 s to 30 s. This is not an attempt of the job and does not call the provider.

**Why:** Each attempt is a paid provider call, and the user is waiting for the result. So the limit is chosen per job type. The random extra prevents jobs that failed at the same time from coming back at the same time. The two kinds of retry are separate, because spending a job's attempt while the database is down would make the job fail unfairly after the outage.

**Check:** `job-outcome.spec.ts`, `kafka-queue-consumer.spec.ts`.

### QUEUE-12: The dead-letter topic is only for unreadable messages

**Rule:** A message whose value does not match the QUEUE-05 schema, that is, one that points to no job, is moved to the topic's dead-letter topic (`jobs.process.dlq`, `exports.process.dlq`; `toDeadLetter` in `src/modules/job-worker/dead-letter.ts`). The original key, value and headers are kept (a missing key or value is forwarded as an empty string), and the source is written to the `source_partition` and `source_offset` headers. The `MESSAGE_INVALID` event is logged at error level. A job whose attempts have all run out does not go to the dead-letter topic: it becomes `failed`, gets an `error_code`, and its credits are released.

**Why:** An unreadable message can never be processed. If it is retried, it holds the partition's commit forever (QUEUE-19). A job whose attempts ran out, on the other hand, needs a result for the user and a release of their credits. A message waiting in a topic does not provide this, the job's final state in the database does.

**Check:** `job-consumer.service.spec.ts`, `job-export-consumer.service.spec.ts`.

## Periodic jobs

### QUEUE-14: Periodic jobs run in every worker

**Rule:** Periodic jobs (outbox relay, reconciler, idempotency key cleanup, export maintenance) start in `onApplicationBootstrap` with `setInterval` or a self-rescheduling `setTimeout`, and are stopped in `onApplicationShutdown`. Every worker runs all of them. `FOR UPDATE SKIP LOCKED` and a conditional `UPDATE`, not a distributed cron lock, prevent two workers from processing the same row. An error in one round is logged, and the next round tries again. The intervals come from config or from the module's `.constants.ts` file.

**Why:** A distributed lock means a single worker does all the work. As the work grows, the other workers stay idle. A lock also brings its own failure modes: if its duration is shorter than the work, there are two owners, and if the place that holds the lock is down, the work never runs. With row locks, correctness is ensured per row, adding workers also speeds up this work, and no new dependency is needed.

**Check:** Code review. Every query of a periodic job uses `SKIP LOCKED` or a conditional update.

### QUEUE-15: A periodic job is safe to run again

**Rule:** A periodic job selects rows by the current condition (for example "`processing` jobs whose lease has expired"), and each change checks the same condition again in `WHERE`. Even if the job runs twice, or on two workers at the same time, the result is the same. Correctness does not depend on a single round running: even if idempotency key cleanup does not run, a new request deletes the expired key itself.

**Why:** `setInterval` can start a new round before the previous one finishes, workers run at the same time, and a round can be cut short. A change that checks its condition again stays correct in all these cases. If the row's state changed after it was selected (the job finished in the meantime), the change affects no row.

**Check:** Code review (reconciler section of `job-lifecycle.service.ts`).

### QUEUE-16: Time is compared with the database clock

**Rule:** The lease expiry (`locked_until`), the redispatch time (`dispatched_at`) and the delivery time (`not_before`, `run_after`) are compared with `now()` inside the query. The lease expiry and a retry's `run_after` are also written based on `now()`: `scheduleRetry` sets `run_after = now() + delay` and returns it, and the settlement uses that value as the outbox row's `not_before`. Only one kind of value comes from the application clock (`DATABASE_STANDARDS.md`, DB-21): the `@default(now())` columns that Prisma Client fills on insert: `created_at`, `run_after` and `dispatched_at` of a new job, `not_before` of a new outbox row.

For this reason the `run_after` value of a job that has never been attempted (`attempt_count = 0`) is not checked (see the comment in `job-lifecycle.service.ts`). The other application-clock values are compared only on a scale of seconds or minutes.

**Why:** The clocks of different servers can differ. When comparisons use a single clock, a worker does not take another worker's job early just because its clock is ahead. For a new job, the same difference would cause the message to be skipped and the job to wait for the reconciler.

**Check:** Code review. `test/job-processing.e2e-spec.ts` (the retry delay is on the database clock).

## Retention and history

### QUEUE-17: Delivery records are deleted

**Rule:** Rows kept for delivery are not history records and are deleted:

| Table | Deleted rows | How |
|---|---|---|
| `job_outbox_messages` | Rows sent more than 1 hour ago (`OUTBOX_RETENTION_MS`) | The relay deletes them once a minute (`OUTBOX_CLEANUP_INTERVAL_MS`) in batches of 1,000. |
| `job_idempotency_keys` | Keys whose lifetime (24 hours) has expired | Every worker deletes them at the `KEY_CLEANUP_INTERVAL_MS` interval, in batches of 1,000 with `SKIP LOCKED`, until none are left. |

Unsent outbox rows are not deleted. The relay's query uses the partial index that contains only unsent rows (`job_outbox_messages_pending_idx`), and the cleanup query uses the one that contains only sent rows (`job_outbox_messages_sent_at_idx`). Cleanup must keep up with the rate at which rows are written.

**Why:** Each job produces at least one outbox row and one key. If they are not deleted, the tables grow without limit with the number of jobs. Thanks to the partial index, the relay's query is not affected by the table's size. Deleting in batches avoids holding long locks during cleanup. One hour is enough to check whether a message was sent when looking into a recent problem. The job's permanent history is in the `jobs` table (QUEUE-18).

**Check:** Code review. The indexes are in the `20261030120700_add_job_outbox_messages_table` migration.

### QUEUE-18: Job history is kept in the jobs table

**Rule:** The job's state and history are in the `jobs` table: `status` (`queued`, `processing`, `completed`, `failed`; Prisma enum `JobStatus`, DB-09), `attempt_count`, `dispatch_count`, `error_code` and `result_source`. The result text is not in `jobs`: it is in the `job_contents` row the job points to with `job_content_id`, shared by all jobs with the same content (`DATABASE_STANDARDS.md`, DB-27). The outbox and Kafka only take the job to the worker. Status queries and API responses do not look at the outbox or Kafka.

**Why:** Delivery records are short-lived (QUEUE-17), while the job's history is listed to the user and exported. Keeping them separate keeps the outbox small, history is not lost, and the database is the single source of truth.

**Check:** Code review.

## Worker

### QUEUE-19: Offsets are committed when the job is done, in order

**Rule:** `QueueConsumer` does not use auto-commit. The messages of a partition are processed side by side, but the offset advances only when all messages before it are done (`PartitionProgress`). The handler's result is one of three kinds:

| Result | Meaning |
|---|---|
| `true` | Processed, can be committed. |
| `false` | The handler gave the message back (the worker is shutting down). It is delivered again, no warning is written. |
| Throws an error | Retried with backoff (QUEUE-11). If the consumer shuts down, it is not committed. |

Memory limits: at most 1,000 uncommitted messages per partition (`MAX_UNCOMMITTED_PER_PARTITION`), a small prefetch (`queued.min.messages: 50`, `queued.max.messages.kbytes: 1024`), and `WORKER_JOB_CONCURRENCY` messages processed at the same time per worker. Partitions lost in a rebalance stop committing.

In librdkafka, `queued.min.messages` is the number of messages per partition the library tries to keep fetched ahead; it is a target, not a ceiling. The upper bound is `queued.max.messages.kbytes`: at most 1,024 KB (1 MB) of fetched messages wait in the consumer's local queue.

**Why:** A message committed before its job is done is lost if the worker crashes. In-order commit keeps at-least-once delivery: the unfinished messages of a crashed worker are delivered again to another worker. The cost is that newer messages that finished before an older one also come again, and this is harmless thanks to QUEUE-09. The library's default prefetches up to 100,000 messages per partition. Without the limits, the worker's memory would grow with the number of jobs in the queue.

**Check:** `partition-progress.spec.ts`, `kafka-queue-consumer.spec.ts`.

### QUEUE-20: A job is claimed right before work on it starts

**Rule:** The worker claims the job not as soon as the message arrives, but right before the provider call, or when the result is known without a call (`JobRun.claim`). The claim sets the job to `processing`, increments `attempt_count`, and writes a random `lock_token` and a lease expiry (`locked_until`, `WORKER_LEASE_MS`). The worker extends the lease every `WORKER_HEARTBEAT_MS`. If the lease has passed to another worker, the job stops. While waiting for provider permission, the job holds nothing in the database. The only write before the claim is the record that a worker received the job (`findClaimable`, QUEUE-22).

**Why:** Claiming waiting jobs locks far more jobs than the worker can call at the same time, and on a crash all of them have to wait for the lease to expire. The lease lets a dead worker's job pass to another worker. The `lock_token` prevents a worker that is still running but whose lease expired and that lost the job from writing the result and capturing the credits a second time.

**Check:** Code review (`job-run.ts`, `job-lifecycle.service.ts`). `WORKER_HEARTBEAT_MS` must be shorter than `WORKER_LEASE_MS` (config validation).

### QUEUE-21: On shutdown, jobs are finished or given back

**Rule:** When SIGTERM arrives, `JobConsumerService.beforeApplicationShutdown`, in order:

1. Stops the consumer, no new messages are taken.
2. `stopTakingJobs`: jobs not yet claimed are dropped. Their messages are not committed and are delivered again.
3. Gives claimed jobs up to `WORKER_SHUTDOWN_GRACE_MS`.
4. If the time runs out, cuts the remaining jobs. A cut job is set to `queued` in the same transaction, its attempt count is rolled back, and a new row is written to the outbox.
5. Stops the consumer: it waits for the messages it is still handling (up to their offset commit), then for pending commits, and then leaves the group, so partitions pass to the other workers at once and messages finished just before the stop are not delivered again.

The connections stay open until all of this is done. NestJS runs `onModuleDestroy`, then `beforeApplicationShutdown`, then `onApplicationShutdown`; so the database, Redis and broker connections are closed in `onApplicationShutdown` (`PrismaService`, `CacheRedisClient`, `KafkaQueuePublisher`), never in `onModuleDestroy`, where they would close before the grace period starts. The relay, the reconciler and key cleanup also stop in `onApplicationShutdown` and wait for a round in progress; NestJS calls that hook on business modules before the infrastructure modules they import, so their last queries finish before the connections close.

**Why:** Shutdown (deploy, scale-down) is not an error and must not spend the user's attempt. Giving the job back at once instead of waiting for the lease to expire lets the job continue on another worker within seconds. The grace period is chosen shorter than the time after which the container is force-stopped (25 s, with `stop_grace_period: 30s` in `docker-compose.yml`).

**Exports:** `JobExportConsumerService` does not wait for running exports to finish. It pauses the topic and aborts their stop signal at once: an export that has not been claimed is not claimed, and a claimed one deletes its unfinished file and goes back to `queued` with its attempt rolled back, through the outbox. A file is cheap to write again, and a 500,000-row file does not fit in a 25 s grace period on a slow disk.

**Check:** `test/shutdown.e2e-spec.ts` (work in the grace period still reaches the database and Redis), `job-outbox-relay.service.spec.ts` (shutdown waits for a running round), `job-consumer.service.spec.ts` (the steps above), `job-export-consumer.service.spec.ts` (exports are stopped, then the group is left), `kafka-queue-consumer.spec.ts` (commit before disconnect).

### QUEUE-22: The reconciler guarantees that every job ends

**Rule:** `JobReconcilerService` runs in every worker at the `RECONCILER_INTERVAL_MS` interval (QUEUE-14) and fixes two cases:

| Case | Action |
|---|---|
| A `processing` job whose lease has expired (the worker died) | If it has attempts left, it is set to `queued` and written to the outbox. If it was the last attempt, or its job type is no longer in the configuration, it becomes `failed` (`worker_lost`) and its credits are released. |
| A `queued` job that was sent but that no worker received (the message was lost) | It is written to the outbox again. The wait before a re-send doubles with each unreceived send: `RECONCILER_STALE_QUEUED_MS × 2^(dispatch_count − 1)`, at most `MAX_REDISPATCH_WAIT_MS` (1 hour). The job is never failed for this. |

`dispatch_count` counts the sends no worker received. A new job, and a job going back to the queue (retry, shutdown, expired lease), starts at 1, each re-send adds 1, and a worker receiving the job (`findClaimable`) or claiming it sets it to 0. The reconciler re-sends only jobs with `dispatch_count > 0`. A job a worker has received is not re-sent however long it waits for a provider permit; if that worker dies, Kafka delivers the uncommitted message again (QUEUE-19).

**Why:** Kafka is the path that takes the job to the worker, not the source of the job's state. A message can be lost, a worker can die before writing the result, an unreadable message can fall into the DLQ. Thanks to the reconciler, none of these cases leaves a job `queued` or `processing` forever, and the user's credits are not left hanging. A backlog is slow, not lost: thousands of queued jobs can wait minutes for a permit, so a waiting job is never failed, and the growing wait keeps a lost message from being re-sent every round.

**Check:** `test/job-processing.e2e-spec.ts` (receipt keeps a waiting job from the reconciler; unreceived sends are re-sent with growing waits and never failed).

**Exports:** `JobExportRunService.maintain` (run by `JobExportMaintenanceService` in every worker at `RECONCILER_INTERVAL_MS`) does the same for exports: an expired lease goes back to `queued`, or to `failed` (`worker_lost`) after the third attempt; an unreceived send is re-sent with the same growing wait. A worker claims an export as soon as it receives it, so the claim also sets `dispatch_count` to 0. The same timer marks ready exports whose file has expired as `expired` and deletes the file. Checked by `test/job-exports.e2e-spec.ts` (maintenance).

### QUEUE-23: Provider calls are limited and shared

**Rule:** Each worker makes at most `WORKER_PROVIDER_CONCURRENCY` (default 4) provider calls at the same time (the semaphore in `JobResolverService`). For the same content, the result is looked up in this order: the cache Redis, the stored result, a call in progress on the same worker, a call in progress on another worker through the call lock in the cache Redis. If none exists, the worker makes the call itself. The time limit starts after permission is granted.

- The call is awaited through `untilAborted` (`src/shared/until-aborted.ts`), so the time limit, lease loss and shutdown hold even for an adapter that ignores the abort signal.
- After the claim, right before the call, the call lock's expiry is restarted to the time limit plus 5 s (`extendCallLock`, `CacheService.extendLock`), so its lifetime counts from the start of the call.
- If the call a job waits on fails (for example, a database error on the other job's claim), the waiting job gets no outcome from it and tries on its own.

**Why:** The limit protects the provider and the worker. The message key (QUEUE-05) already gathers the same content on the same worker, and the call lock covers exceptions such as a rebalance. Redis only saves calls: if it is down, the stored result and in-worker sharing still apply (CACHE-07). The time limit bounds the provider call, not the wait for permission.

**Check:** `test/job-processing.e2e-spec.ts` (a failing leader's follower takes over; the call lock lifetime counts from the call; the time limit holds for a provider that ignores its signal), `until-aborted.spec.ts`, `cache.service.db-spec.ts` (`extendLock`).

## Pending proposals

The items below are not rules yet.

- **Total limit per provider.** `job_providers.max_concurrency` exists in the table but is not applied. Today total concurrency equals the number of workers times `WORKER_PROVIDER_CONCURRENCY`.
- **The dead-letter topics are monitored.** When a message falls into a `.dlq` topic, a notification goes to the team. The notification channel and tool will be chosen separately.
- **Topics are replicated.** The development environment has a single broker and `replication-factor 1`. In production, without 3 replicas and `min.insync.replicas=2`, `acks: -1` gives no protection against losing a broker.

## Technical details

**Producer:** `QueuePublisher` uses an idempotent producer and `acks: -1`. Network retries within the same producer session are not written twice. If the producer restarts, duplicate messages can occur, and QUEUE-09 handles this.

**Consumer groups:** `job-workers` (`jobs.process`) and `export-workers` (`exports.process`). `sessionTimeout` 10 s, `heartbeatInterval` 3 s. The partitions of a worker that sends no heartbeat pass to the other workers within 10 s. On first join, the topic is read from the beginning (`fromBeginning`).

**Scale:** The partition count (12) limits the number of workers that can share the topic, not the number of jobs processed at the same time. For more workers, the partition count is increased. This changes the key-to-partition mapping, but since messages carry only the job ID, it does not affect correctness. It only reduces call sharing during the transition.
