# Architecture Standards

This document defines how the code is split into folders, how layers and modules use each other, and how the API and the worker are built from the same codebase. Every rule has an ID (such as `ARCH-01`). Use this ID to refer to a rule in code review.

For the file layout inside folders and for how imports are written, rules CODE-12 and CODE-13 in `CODING_STANDARDS.md` apply.

If a rule changes, this file, the code comments that refer to the rule and the other documents are updated together.

> **Status:** The rules are applied in the code (31 October 2026). The Kafka message schema is in `src/modules/job-outbox/messages/job-dispatch.message.ts`; the relay and the consumer both use it (ARCH-05). The project consists of two processes: the API (`src/main.ts`) and the worker (`src/worker.ts`). The business modules are `health`, `users`, `jobs`, `job-config`, `job-contents`, `job-idempotency`, `job-outbox` and `job-worker`.

## Rule summary

| ID | Rule |
|---|---|
| ARCH-01 | `src` is split into four layers: `shared`, `core`, `infra` and `modules`. Only entry points and root modules sit at the root of `src`. |
| ARCH-02 | A layer imports only the layers below it. |
| ARCH-03 | Each external system has one folder under `infra`. The folder name states the system's role; the class name or a subfolder states the technology. |
| ARCH-04 | A module is named after the tables it owns. A module without tables is named after the work it does. |
| ARCH-05 | A module imports from another module only its NestJS module file, its service, its constants file, and its `dto` and `messages` folders. |
| ARCH-06 | Every table is owned by one module. A module writes only to its own tables. |
| ARCH-07 | Work that must be committed together is done with a service call in the same transaction; work to be done later goes through the outbox as a Kafka message. |
| ARCH-08 | There are no circular dependencies between modules. `forwardRef` is not used. |
| ARCH-09 | Controllers, the Kafka consumer and timer loops only call the service. Business rules are written in the service. |
| ARCH-10 | Only `core` and `infra` modules that both processes need may be global. |
| ARCH-11 | The API and the worker are two separate processes from the same codebase. Each builds its own root module and loads only the modules it needs. |
| ARCH-12 | An external system's library is imported only in that system's `infra` folder. Prisma is exempt from this rule. |

## Layers

### ARCH-01: src is split into four layers

**Rule:** The `src` folder consists of the four layers below. Only entry points and root modules sit at the root of `src`: `main.ts` and `app.module.ts` (API), `worker.ts` and `worker.module.ts` (worker), `generate-openapi.ts` (generates the OpenAPI file) and `seed.ts` (writes sample data for query measurement).

| Layer | Contents | In this project |
|---|---|---|
| `shared` | Pure functions and types that depend neither on NestJS nor on other project code | `uuid-v7.ts`, `job-content.ts` (normalizes the input and computes its digest), `semaphore.ts`, `sleep.ts`, `describe-error.ts`, `succeeds.ts` (whether an operation finished without an error), `until-aborted.ts` (stops waiting for a promise when a signal aborts) |
| `core` | NestJS code the application needs to run, with no business rules | `config`, `context`, `logging`, `errors`, `validation`, `http`, `auth` (`X-User-Id` header) |
| `infra` | Code that connects to an external system. Each folder represents one external system. | `database`, `cache`, `queue/kafka`, `ai-provider`, `file-store/local` |
| `modules` | Business areas, endpoints and the worker flow | `health`, `users`, `jobs`, `job-config`, `job-contents`, `job-exports`, `job-idempotency`, `job-outbox`, `job-worker` |

```
src/
  main.ts  app.module.ts          API
  worker.ts  worker.module.ts     worker
  generate-openapi.ts  seed.ts    command-line tools
  shared/
  core/
    auth/  config/  context/  errors/  http/  logging/  validation/
  infra/
    ai-provider/  cache/  database/  file-store/local/  queue/kafka/
  modules/
    health/  users/  jobs/
    job-config/  job-contents/  job-exports/  job-idempotency/  job-outbox/  job-worker/
```

The code Prisma generates is outside `src`, in the `prisma/generated` folder, and is imported through the `#generated` path. It is not a layer, it is not added to git and it is not edited by hand. Because the build also includes this folder (`tsconfig.build.json`), the compiled application is under `dist/src` and the compiled Prisma code is under `dist/prisma/generated`.

**Why:** A file's location says what it does: code that connects to an external system is in `infra`, business rules are in `modules`. When looking for the source of a problem, the places to look are fewer. A change related to an external system (a Redis timeout, a Kafka producer setting) does not touch business code.

**Check:** Code review.

### ARCH-02: A layer imports only the layers below it

**Rule:** The layers are ordered from top to bottom: `modules`, `infra`, `core`, `shared`. A layer imports only the layers below it.

| Layer | Can import |
|---|---|
| `modules` | `infra`, `core`, `shared` and other modules (within the limits of ARCH-05) |
| `infra` | `core`, `shared` |
| `core` | `shared` |
| `shared` | No layer. NestJS is not imported either. |

```
modules  →  infra  →  core  →  shared
```

Files at the root of `src` can import any layer, because they are where the parts are put together. Example: the error filter in `core/errors` does not know `PrismaErrorMapper`, which translates Prisma errors. `app.module.ts` builds the list of mappers and provides it through `PROBLEM_MAPPERS`.

**Why:** When dependencies flow in one direction, no cycles form and a lower layer is not affected by a change above it. `infra` uses `core` for environment variables and logging, so `core` cannot use `infra`. This is why the health endpoint, which uses both the database and Redis, is under `modules`. Because `shared` does not depend on NestJS, code that runs outside Nest, such as `seed.ts`, can also use it.

**Check:** Lint. In `.oxlintrc.json`, one override per layer uses the `no-restricted-imports` rule to forbid the `#` paths of upper layers. For `shared`, `@nestjs/**` is also forbidden. Lint sees only paths that start with `#`; it does not catch an import that skips a layer through a relative path (`../../modules/...`). This is why CODE-13 requires imports between layers to be written with `#` paths.

### ARCH-03: infra folders are named by role

**Rule:** Each folder under `infra` represents one external system, and its name states that system's role in the application: `database`, `cache`, `queue`, `ai-provider`, `file-store`. The technology used appears either in the class name (`PrismaService`, `CacheRedisClient`, `RedisThrottlerStorage`) or in a folder under the role folder (`queue/kafka`, `ai-provider/adapters/fake`, `file-store/local`).

The three external systems we expect to replace or add to, the queue broker, the AI provider and the store of prepared files, are split into a port and adapters. The port is the role folder's own file (`queue/queue.ts`, `ai-provider/ai-provider.ts`, `file-store/file-store.ts`), written in the application's terms. An adapter is a subfolder that implements it with one technology. Modules import only the port; lint rejects an import of an adapter folder.

| Folder | External system | Contents |
|---|---|---|
| `database` | PostgreSQL | `PrismaService`, the mapper that translates Prisma errors, the health check |
| `cache` | Redis | `CacheRedisClient` (connection), `CacheService` (read, write, lock), rate limit counters, the health check |
| `queue` | the broker | the port (`queue.ts`) and `QueueModule`, which loads the driver `QUEUE_DRIVER` names |
| `queue/kafka` | Kafka | `KafkaClient`, `KafkaQueuePublisher`, `KafkaQueueConsumer`, `KafkaQueueModule` |
| `ai-provider` | AI providers | the port (`AiProvider`, the two error classes), the adapter catalogue, `ConcurrencyTrackingAiProvider`, `AiProviderRegistry` |
| `ai-provider/adapters/fake` | the case's fake provider | `FakeAiProvider` |
| `file-store` | where prepared files live | the port (`FileStore`, `FileUpload`) and `FileStoreModule` |
| `file-store/local` | a directory (a shared Docker volume) | `LocalFileStore`: writes to a temporary name, renames on commit |

**Why:** When the folder name is a role, a reader understands what the code is for without knowing the technology. Because the technology name appears in the class or the subfolder, the fact that the code uses Prisma, ioredis or Kafka directly is not hidden either. Kafka has its own subfolder so that the technology is visible in the path. The port keeps the other layers independent of it: `QueueMessage` and `ReceivedMessage` are plain types in `queue.ts`, so neither the Kafka library's types nor Kafka words (partition, offset) reach a module; a broker's position of a message travels as the opaque `source` field. Replacing or adding a broker or a provider is then a new adapter folder plus one registration line (QUEUE-01, `ai-provider.catalogue.ts`), and nothing outside `infra` changes.

**Check:** Lint: in `src/modules`, imports of `#infra/queue/*/**`, `#infra/ai-provider/adapters/**` and `#infra/file-store/*/**` fail (`.oxlintrc.json`). Code review for the rest.

## Modules

### ARCH-04: A module's name states the tables it owns

**Rule:** Each module is a kebab-case folder under `src/modules/<module>`. The name of a module that has tables matches the names of its tables. A module without tables is named after the work it does.

| Module | Tables it owns |
|---|---|
| `users` | `users`, `user_credit_ledger` |
| `jobs` | `jobs` |
| `job-config` | `job_types`, `job_providers`, `job_type_routes` |
| `job-contents` | `job_contents` |
| `job-idempotency` | `job_idempotency_keys` |
| `job-outbox` | `job_outbox_messages` |
| `job-exports` | `job_exports`. It also reads `jobs` to write the CSV (reads are free, ARCH-06). |
| `job-worker` | None. It takes jobs from Kafka, calls the provider and has the owning modules write the result. |
| `health` | None. It returns the state of the database and Redis. |

The modules of the tables tied to a job start with the same prefix (`job-`). The service and the NestJS module are named after the folder: `job-contents` → `JobContentsService`, `JobContentsModule`.

**Why:** Who writes to a table (ARCH-06) can be guessed from the module name: there is no need to search for the owner of the `job_idempotency_keys` table. The shared prefix keeps the modules of a job next to each other in the folder listing. If `jobs` were one big module, the rules of six tables, the endpoints and the worker flow would all sit in it together. The split version gathers each table's write rules in a small service.

**Check:** Code review.

### ARCH-05: Import boundary between modules

**Rule:** A module imports only these files from another module:

- The NestJS module file (`*.module.ts`). To use the service, the module must be added to the `imports` list.
- The service file (`*.service.ts`): the service itself and the types the service exports as parameter or return types (such as `ClaimedJob`, `JobTypeLimits`).
- The constants file (`*.constants.ts`): constants, error codes and Kafka topic names that other modules also need to know.
- Files in the `dto/` folder.
- Files in the `messages/` folder (Kafka message schemas).

Controllers, internal helper files (`job-route.ts`, `job-csv.ts`) and `*.errors.ts` are not imported from other modules. Error codes another module needs (for example to document them on its endpoint) are in the owner's `.constants.ts` file (`UserErrorCode`, `JobExportErrorCode`).

**Why:** The service, constants, DTOs and messages are the contract a module exposes. Internal files are outside this contract, so the module can change its internals without breaking other modules. A boundary drawn by file type can be checked by lint; an abstract description such as "contract" cannot.

**Example:**

```ts
// src/modules/job-worker/job-settlement.service.ts
import { UsersService } from '#modules/users/users.service.ts';                           // allowed
import { type ClaimedJob, JobLifecycleService } from '#modules/jobs/job-lifecycle.service.ts'; // allowed
import { JOB_DISPATCH_TOPIC } from '#modules/job-outbox/job-outbox.constants.ts';           // allowed
import { pickRoute } from '#modules/job-config/job-route.ts';                               // forbidden
```

**Check:** Lint (`.oxlintrc.json`, the `src/modules/**` override). Allowed patterns: `*.module.ts`, `*.service.ts`, `*.constants.ts`, `dto/**`, `messages/**`. NestJS checks whether the service is in the `exports` list: if code tries to inject a service that is not exported, the process fails at startup.

### ARCH-06: Every table is owned by one module

**Rule:** Every database table is owned by exactly one module (the table in ARCH-04).

- A module writes only to its own tables (`create`, `update`, `delete`, `upsert`, `$executeRaw` and a `$queryRaw` that writes). If another module's table must change, that module's service is called.
- Reads are free. A module can read other modules' tables with `include` or a join.
- The comment at the top of the owning service or NestJS module names its tables (`// Owns job_outbox_messages: ...`).
- A module without tables (`job-worker`) can open a transaction and pass `tx` to the owners' services, but it does not write to a table itself.

The Prisma schema is in the `prisma/schema` folder and is split into files by tables that change together: `users.prisma` (the `users` module), `jobs.prisma` (the tables of the `jobs` and `job-*` modules). A table's owner is found from the table in ARCH-04 and from the owner's comment, not from the schema file name.

**Why:** The rules that must be followed when writing to a table sit in one service and are not repeated elsewhere. Example: every balance change writes a `user_credit_ledger` record in the same transaction. Because this rule is only in `UsersService`, no second path forms that changes the balance without a ledger record. Reads are free because a read cannot break the table's rules, and writing several queries instead of a join only adds cost.

The schema files are split per job, not per module, because the `job-*` tables are linked to each other by foreign keys and Prisma requires both sides of a relation in the model. In a schema split into five files, reading one relation would require opening several files.

**Example:**

```ts
// src/modules/jobs/jobs.service.ts, the job creation transaction
await this.users.requireUser(tx, job.userId);           // users table: owned by UsersService
await this.contents.upsert(tx, { ... });                 // job_contents: owned by JobContentsService
await tx.job.create({ data: { ... } });                  // jobs: its own table
await this.outbox.enqueue(tx, { ... });                  // job_outbox_messages: owned by JobOutboxService
await this.users.reserveCredits(tx, { ... });            // users, user_credit_ledger
await tx.user.update({ ... });                           // forbidden: users table
```

**Check:** Code review. Queries that write can be listed with `rg "INSERT INTO|UPDATE |DELETE FROM|\.(create|update|delete|upsert)" src/modules`.

### ARCH-07: Service call or outbox message

**Rule:** A module triggers another module's work in one of two ways:

- **Service call:** If the caller will use the result right away, or if two changes must be committed together, the other module's service is called directly. Methods that must run in the same transaction take `tx: Prisma.TransactionClient` as their first parameter. The service that drives the flow opens the transaction (`JobsService.create`, `JobSettlementService.settle`, `JobReconcilerService`).
- **Outbox message:** For work to be done later, in another process, an outbox record is written with `JobOutboxService.enqueue` in the same transaction. The relay in the worker sends this record to Kafka (`QUEUE_STANDARDS.md`, QUEUE-08).

If the result of a piece of work decides whether the main operation is accepted, that work is not turned into a message. Example: if credits are not enough, the job must be rejected. If the credit reserve were done in the worker, the client would already have received 202 and the job would have been accepted.

**Why:** A service call shows the flow in one place, and a single transaction makes half-finished states such as "credits were deducted but the job was not created" impossible. Writing to Kafka directly from the API opens a gap between the database commit and the Kafka send: if one succeeds and the other fails, a job is lost or a job that never existed is processed. The outbox reduces these two writes to one commit and isolates the API from a Kafka outage.

**Example:**

| Case | Path |
|---|---|
| Credits are reserved when the job is created. If credits are not enough, the job is not created. | Service call: `users.reserveCredits(tx, ...)` |
| When an attempt ends, the job's status, its result and the credit capture are written together. | Service calls: `lifecycle.complete(tx, ...)`, `contents.saveResult(tx, ...)`, `users.captureCredits(tx, ...)` |
| An accepted job is sent to the worker, or its retry is scheduled. | Outbox: `outbox.enqueue(tx, { jobId, notBefore, ... })` |

**Check:** Code review.

### ARCH-08: No circular dependencies

**Rule:** Two modules do not import each other, directly or indirectly. NestJS's `forwardRef` workaround is not used. If two modules need each other, one of two paths is chosen:

1. One direction is turned into an outbox message (ARCH-07).
2. The part both modules need is moved to a separate module, or to a separate NestJS module in the same folder.

**Why:** With a circular dependency, which module loads first becomes unclear, and hard-to-understand errors occur at process startup. `forwardRef` hides the cycle but does not remove it: the two modules still know each other's internals.

**Example:** The `jobs` module creates the job; `job-worker` changes the job's status. If the status changes were in `JobsModule`, `job-worker` would have to load the whole HTTP layer. Instead, there is a separate `JobLifecycleModule` in the `jobs` folder:

```
jobs        →  users, job-config, job-contents, job-idempotency, job-outbox
job-worker  →  jobs (only JobLifecycleModule), users, job-config, job-contents,
               job-idempotency (only cleanup), job-outbox
```

No `job-*` module other than `job-worker` imports `jobs`, and no module imports `job-worker`.

**Check:** Lint (importing `forwardRef` from `@nestjs/common` is forbidden). Two modules importing each other is checked in code review.

### ARCH-09: Controllers, the consumer and loops only call the service

**Rule:** A controller validates the request, calls the service and returns the result. The Kafka consumer (`JobConsumerService`) decodes the message and calls the service. Timer-driven loops (the relay, the reconciler and the idempotency cleanup, set up with `setInterval` or `setTimeout`) call a service method. Business rules, database access and cache use are written in the service.

The consumer's own work belongs to transport: decoding the message with a zod schema, sending a message that cannot be decoded to the dead-letter topic (`jobs.process.dlq`), and finishing the jobs it has taken when shutting down.

**Why:** The same business rule works the same way whether it is called from HTTP, Kafka, a loop or a test. Example: `JobProcessorService` also works without Kafka. The worker feeds it from Kafka; `test/job-processing.e2e-spec.ts` calls it directly.

**Example:**

```ts
@Get(':id')
@ApiEndpoint({ ... })
get(@UserId() userId: string, @Param(new ZodValidationPipe(JobIdParamsSchema)) params: JobIdParams): Promise<JobDto> {
  return this.jobs.get(userId, params.id);
}
```

```ts
// JobConsumerService
private async handle(message: ReceivedMessage): Promise<boolean> {
  const jobId = jobIdOf(message.value);
  if (!jobId) {
    await this.deadLetter(message);
    return true;
  }
  try {
    return await this.processor.process(jobId, requestIdOf(message.headers) ?? generateRequestId());
  } catch (error) {
    // An infrastructure error (the database is down). The consumer retries
    // the message after a pause; on shutdown it is delivered again later.
    this.logger.error(JobWorkerLogEvent.JOB_PROCESSING_FAILED, { jobId, reason: describeError(error) });
    throw error;
  }
}
```

**Check:** Code review. `PrismaService` and `CacheService` are not used in controller and consumer files.

### ARCH-10: Only core and infra modules may be global

**Rule:** `@Global()` is used only in modules under `core` and `infra` that both processes use: `ContextModule`, `LoggingModule`, `PrismaModule`, `CacheModule`. `ConfigModule` is loaded in the root modules with `isGlobal: true`. `infra` modules that only one process needs (`QueueModule`, `AiProviderModule`) are not global; the module that uses them adds them to its `imports` list. Business modules are not global.

**Why:** Configuration, logging, the database and the cache are used in almost every service; importing them again in every module carries no information. Kafka and the AI providers, however, are needed only in the worker. If they were global, the API would load them too, and a Kafka outage would affect API startup (ARCH-11). Dependencies between business modules must be visible from the `imports` list.

**Check:** Code review.

### ARCH-11: The API and the worker are two separate processes

**Rule:** Two processes run from the same codebase. Each loads only the modules it needs, with its own entry point and root module.

| | API | Worker |
|---|---|---|
| Entry point | `src/main.ts` (`NestFactory.create`, HTTP server) | `src/worker.ts` (`NestFactory.createApplicationContext`, no HTTP) |
| Root module | `AppModule` | `WorkerModule` |
| Business modules | `HealthModule`, `UsersModule`, `JobsModule` | `JobWorkerModule` |
| Queue broker | Not loaded. Jobs are written to the outbox table. | `QueueModule.register()` (Kafka by default): consumer and relay |
| AI providers | Not loaded | `AiProviderModule` |
| Background loops | None | Outbox relay, reconciler, export maintenance, cleanup of expired idempotency keys |

If the two processes need different parts of a module, the parts are separate NestJS modules in the same folder:

| Folder | Loaded by the API | Loaded only by the worker |
|---|---|---|
| `job-outbox` | `JobOutboxModule` (writes records) | `JobOutboxRelayModule` (sends to Kafka) |
| `job-idempotency` | `JobIdempotencyModule` | `JobIdempotencyCleanupModule` |
| `jobs` | `JobsModule` (endpoints) | `JobLifecycleModule` (status changes) |
| `job-exports` | `JobExportsModule` (endpoints, admission) | `JobExportRunModule` (prepares files; the API loads it too, for the CSV writer) |
| `job-worker` | | `JobWorkerModule` (Kafka consumer), `JobProcessingModule` (processing without Kafka) |

Background loops run in every worker instance. Instances are kept from processing the same row twice by a row lock (`FOR UPDATE SKIP LOCKED`), not by leader election.

**Why:** The API and the worker scale for different reasons: the API with the number of requests, the worker with provider capacity. Separate processes can run different numbers of instances, and when one crashes the other is not affected. Because the API does not load Kafka, it keeps accepting jobs during a Kafka outage; the jobs wait in the outbox. If the loops ran in the API, every API instance would add its own load on the database. The same codebase guarantees at compile time that both processes use the same services, the same schema and the same types. A row lock is simpler than leader election: no extra component is needed, and when one instance crashes, the others take over its work.

**Check:** Code review. When a new module is added, check which root module loads it and whether it pulls in Kafka indirectly.

### ARCH-12: An external system's library stays in its own infra folder

**Rule:** An external system's client library is imported only in that system's `infra` folder:

| Library | Only in |
|---|---|
| `ioredis` | `src/infra/cache` |
| `@confluentinc/kafka-javascript` | `src/infra/queue/kafka` (a future broker's library: its own `src/infra/queue/<driver>`) |

Other layers use these folders' own classes and types (`CacheService`, `QueuePublisher`, `QueueMessage`). The library's types do not appear in the public methods of these classes.

Prisma is exempt from this rule. Services use `PrismaService` and the `#generated` types directly (`DATABASE_STANDARDS.md`, DB-11). Tests (`test/`, `*.spec.ts`) can use the libraries directly; for example, the test setup uses `ioredis` to flush Redis.

**Why:** Decisions about the library's behavior sit in one place: the Redis command timeout and the disabled offline queue are in `CacheRedisClient`; the Kafka producer being idempotent with `acks: -1` is in `QueuePublisher`. If the library changes or a version breaks compatibility, only that folder changes. This boundary is not applied to Prisma, because queries are part of the business rules and a layer wrapping them would only repeat Prisma's query language.

**Check:** Code review. `rg "from 'ioredis'|kafka-javascript" src` must show only these folders.

## Technical details

**Lint setting:** The layer rules (ARCH-02), the module boundary (ARCH-05) and the `forwardRef` ban (ARCH-08) are written in `.oxlintrc.json` with `no-restricted-imports` (oxlint 1.89). Each layer has its own override.

- Patterns use `#modules/**` instead of `#modules/*`. A single-star pattern does not match files in subfolders.
- Do not rely on the `no-restricted-imports` setting inside an override being merged with the top-level setting. This is why the `forwardRef` ban is repeated in every override.

**Known limit:** Lint checks only paths that start with `#`. An import written with a relative path (`../../modules/...`) does not trip these rules. Compliance with CODE-13 is checked in code review.

**Prisma schema folder:** `prisma.config.ts` contains `schema: 'prisma/schema'`. Prisma merges all `.prisma` files in the folder into one schema and validates relations across files (`User` with `Job`). The generator and the datasource are in `schema.prisma`.
