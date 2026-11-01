# Coding Standards

This document defines the rules to follow when writing TypeScript and NestJS code. Each rule has an ID (such as `CODE-01`). Use this ID to refer to a rule in code review.

Database, cache and queue code must also follow the rules in `DATABASE_STANDARDS.md`, `CACHE_STANDARDS.md` and `QUEUE_STANDARDS.md`. Layers and module boundaries are in `ARCHITECTURE_STANDARDS.md`.

If a rule changes, this file, the code comments that refer to the rule, `.oxlintrc.json` and the other documents are updated together.

> **Status:** The rules are applied to the code (31 October 2026). The rules checked by lint are in `.oxlintrc.json`, and `npm run lint` passes without errors.

## Rule summary

| ID | Rule |
|---|---|
| CODE-01 | File names are lowercase with hyphens. NestJS and infrastructure roles end with the file type (`jobs.service.ts`). |
| CODE-02 | Class and type names are PascalCase. |
| CODE-03 | Database and message fields are snake_case; API fields, log fields and the rest of the code are camelCase. |
| CODE-04 | Names and comments are in English. |
| CODE-05 | A comment only explains why the code is written this way. |
| CODE-06 | Fixed lists in code are defined with an `as const` object. TypeScript `enum` is not used. |
| CODE-07 | Only named exports are used. |
| CODE-08 | `any` and `unknown` are not used. Every value has a concrete type. |
| CODE-09 | Non-null assertion (`!`) is not used. |
| CODE-10 | Public methods and exported functions declare their return type. |
| CODE-11 | Data from outside is validated with a zod schema: requests, headers, Kafka messages and environment variables. |
| CODE-12 | Feature modules use the same folder layout. |
| CODE-13 | Imports are written with the `.ts` extension. Imports across folders use the `#shared`, `#core`, `#infra`, `#modules` and `#generated` paths. |
| CODE-14 | Environment variables are read only inside `src/core/config`. |
| CODE-15 | Code that does the same thing is written in one place. |
| CODE-16 | Code follows the SOLID principles. |
| CODE-17 | A function has at most 9 decision points (complexity 10), 3 levels of nested blocks and 50 lines. |
| CODE-18 | Behaviors whose options are open-ended and each carry their own dependency use the strategy pattern; a closed set of outcomes uses a discriminated union type. |
| CODE-19 | Meaningful strings and numbers are not written directly in code; they are defined as constants or literal types. |
| CODE-20 | The test is written before a new service method or endpoint. |
| CODE-21 | Write the simplest solution that meets today's need. Do not abstract for possible future needs. |

## Naming

### CODE-01: File names are lowercase with hyphens

**Rule:** A file name is lowercase and words are separated by hyphens. If the file has a NestJS or infrastructure role, the role follows the name:

| Role | Example |
|---|---|
| `.module.ts`, `.controller.ts`, `.service.ts` | `job-outbox-relay.module.ts`, `jobs.controller.ts`, `job-settlement.service.ts` |
| `.dto.ts` | `dto/job.dto.ts`, `dto/user-credits.dto.ts` |
| `.constants.ts`, `.errors.ts` | `job-worker.constants.ts`, `jobs.errors.ts` |
| `.guard.ts`, `.decorator.ts`, `.middleware.ts`, `.interceptor.ts`, `.filter.ts`, `.pipe.ts` | `user-id.guard.ts`, `idempotency-key.decorator.ts` |
| `.client.ts`, `.indicator.ts`, `.mapper.ts`, `.registry.ts`, `.storage.ts` | `cache-redis.client.ts`, `prisma-error.mapper.ts`, `ai-provider.registry.ts` |
| `.options.ts`: builds the options object of a NestJS module | `rate-limit.options.ts` |
| `.message.ts`: a queue message schema with its build and read functions, under `messages/` | `messages/job-dispatch.message.ts` |
| `.catalogue.ts`: every adapter of a port this build can load, by name | `ai-provider.catalogue.ts` |
| `.schema.ts`: a zod schema shared outside `dto/` | `problem-details.schema.ts` |
| `.validation.ts`: validation of environment variables | `env.validation.ts` |
| Tests: `.spec.ts`, `.db-spec.ts`, `.e2e-spec.ts` | `job-outcome.spec.ts`, `cache.service.db-spec.ts`, `test/jobs.e2e-spec.ts` |

Files without a role (pure functions, types, plain classes) carry only the name of what they contain: `job-outcome.ts`, `job-run.ts`, `job-csv.ts`, `fake-ai-provider.ts`, `uuid-v7.ts`. A port file carries the role folder's name: `queue/queue.ts`, `ai-provider/ai-provider.ts`.

**Why:** The role suffix tells what the file is without opening it, and it is the basis of the lint pattern in ARCH-05 (`*.service.ts`, `*.constants.ts`). Inventing a suffix for a file without a role (`job-outcome.helper.ts`) adds no information.

**Check:** Code review.

### CODE-02: Class and type names are PascalCase

**Rule:** Class, type and interface names are PascalCase. The name of a class with a role ends with that role and matches the file name: `job-settlement.service.ts` → `JobSettlementService`, `cache-redis.client.ts` → `CacheRedisClient`.

**Why:** This is the convention of the TypeScript and NestJS ecosystem. When the class name can be guessed from the file name, search and renaming are easier.

**Check:** Code review.

### CODE-03: Database and message fields are snake_case, API, log and code are camelCase

**Rule:** These fields are snake_case:

- Prisma model fields and columns in raw SQL (`DATABASE_STANDARDS.md`, DB-02)
- The content and headers of a Kafka message (`{ job_id }`, `request_id`)

DTO fields (request body, query parameter and response) and log fields are camelCase (`API_STANDARDS.md`, API-05; `ERROR_AND_LOGGING_STANDARDS.md`, LOG-03). The rest of the code is camelCase too: variables, functions, methods, parameters and the fields of types passed between services (`CreditReservation`, `JobDispatch`).

The mapping between a Prisma record and a DTO is done in the function that builds the response DTO (`toJobDto`, `toJobListItemDto`; `SECURITY_STANDARDS.md`, SEC-06).

Constants are outside this rule. Module-level constants are uppercase with words separated by underscores (`JOB_DISPATCH_TOPIC`, `RETRY_BASE_DELAY_MS`). `as const` lists are PascalCase (`JobFailureCode`), because they also define a type with the same name (CODE-06).

**Why:** Database columns use snake_case, which needs no quotes in SQL. This project writes some queries in raw SQL, so a Prisma field name must match the column name; otherwise the two names need translating. A Kafka message is built from a database row and may also be read by a consumer written in another language, so it keeps the column format. The API uses camelCase, the native format of its clients (JavaScript and mobile), and the client uses the response without converting it. The mapping needs no separate layer, because the response is already built by a DTO function. Log fields use the same format as the API: `jobId` in the response and `jobId` in the log are searched by the same name.

**Example:**

```ts
// src/modules/jobs/jobs.service.ts: service type camelCase, Prisma field snake_case
await tx.job.create({
  data: {
    id: job.jobId,
    user_id: job.userId,
    job_content_id: contentId,
    cost: job.jobType.cost,
  },
});
this.logger.log(JobLogEvent.JOB_CREATED, { jobId: result.jobId, jobType: command.type });

// src/modules/job-outbox/messages/job-dispatch.message.ts: Kafka message snake_case
const JobDispatchSchema = z.object({ job_id: z.uuid() });
const REQUEST_ID_HEADER = 'request_id';

value: JSON.stringify({ job_id: dispatch.jobId } satisfies z.infer<typeof JobDispatchSchema>),
headers: { [REQUEST_ID_HEADER]: dispatch.requestId },
```

**Check:** Code review.

### CODE-04: Names and comments are in English

**Rule:** Variable, function, class and file names, code comments, log event codes and error messages are written in English. The standards documents, `README.md` and `docs/design.md` are in English too.

**Why:** When a comment is in the same language as the English names next to it, it reads in one language. When English code names appear inside a Turkish comment, the sentences become a mix of two languages.

**Check:** Code review.

### CODE-05: A comment explains why

**Rule:** Names show what the code does, so no comment explains that. Write a comment when the code does not show why it is written this way: a race condition, an ordering requirement, the source of a limit value, a risk accepted on purpose. Do not leave commented-out code.

A comment at the top of a class or service may describe what the class guarantees (`// Owns job_outbox_messages: ...`). This does not say what the class does; it says why other code can rely on it.

**Why:** A comment that repeats the code is not updated when the code changes, and then gives wrong information. A comment that explains why carries information the code cannot show: if it is deleted, the next person removes a line that looks "unnecessary" and brings the bug back.

**Example:**

```ts
// Wrong
// Set enableOfflineQueue to false
enableOfflineQueue: false,

// Right (src/infra/cache/cache-redis.client.ts)
// Fail fast instead of queueing commands while Redis is down, so a cache
// outage falls back to the database without waiting (CACHE-07).
enableOfflineQueue: false,
```

**Check:** Code review.

## TypeScript

### CODE-06: Fixed lists are defined with an as const object

**Rule:** Fixed value lists in code are defined with an `as const` object and a union type derived from it. TypeScript `enum` is not used. How a list stored in the database is defined follows `DATABASE_STANDARDS.md`, DB-09. A closed list that database rules depend on is a Prisma enum (`job_status`). Prisma also generates these as `as const` objects, and code uses them from the `#generated/prisma/enums.ts` path (`JobStatus.queued`). A list that grows with the code is a `VarChar` column, and its values are an `as const` object in code (`jobs.error_code`, `JobFailureCode`).

**Why:** An `as const` object stays a plain JavaScript object after compilation; its values can be iterated at runtime and used as a type. TypeScript `enum` generates extra code and behaves unexpectedly with numeric enums: any number can be assigned to a numeric enum type. The lists Prisma generates have the same shape, so the code has a single list format.

**Example:**

```ts
// src/modules/job-worker/job-worker.constants.ts
export const JobFailureCode = {
  PROVIDER_REJECTED: 'provider_rejected',
  PROVIDER_TIMEOUT: 'provider_timeout',
} as const;

export type JobFailureCode = (typeof JobFailureCode)[keyof typeof JobFailureCode];
```

**Check:** Code review. `.oxlintrc.json` has no rule that bans `enum`.

### CODE-07: Named exports only

**Rule:** `export default` is not used. Everything is exported by name and imported with the same name in every file.

**Exception:** Config files where the tool requires a default export (`prisma.config.ts`, `vitest.config.ts`).

**Why:** A class is referred to by the same name in every file. Renaming and search tools work correctly.

**Check:** Lint (`import/no-default-export`). Config files are in the project root, so lint does not cover them (lint scans only the `src/` and `test/` folders).

### CODE-08: any and unknown are not used

**Rule:** `any` and `unknown` are not written in parameter, variable, class property and return types. Every value has a concrete type.

In some places TypeScript itself types a value as `unknown` or `any`: the error in a `catch` block, the result of `JSON.parse`, incoming request and message content. These values are converted to a concrete type with a zod schema or an `instanceof` check before use. A value of unclear type is not passed to another function. If a thrown value only needs to become text for a log, use `describeError`.

**Exception:** Infrastructure code that converts every thrown or incoming value to a concrete type may write `unknown`: `src/core/config`, `src/core/validation`, `src/core/errors` (catches every thrown value), `src/core/logging/app-logger.ts` (extends a NestJS method), `src/core/logging/mask.ts` (walks log values of any kind), `src/shared/describe-error.ts`, `*.mapper.ts` files and `src/infra/database/prisma-errors.ts`. These files are defined as exceptions in the lint settings.

**Why:** `any` turns off type checking. `unknown` leaves the value's type unclear and needs an extra check everywhere it is used. When the conversion happens once at the boundary, the rest of the code works with concrete types and the handling of an error type is visible in one place.

**Example:**

```ts
// Wrong
function readJobId(message: any): string {
  return message.job_id;
}

// Right (src/modules/job-worker/job-resolver.service.ts)
} catch (error) {
  return this.classify(error instanceof Error ? error : new Error(String(error)), stop, timeout);
}
// classify: PermanentAiError → permanent, TransientAiError → transient
```

**Check:** Lint (`typescript/no-explicit-any` and `typescript/no-restricted-types`). The implicit `unknown` in a `catch (error)` block does not trigger lint, because no type is written. Code review checks that this value is converted to a concrete type.

### CODE-09: Non-null assertion is not used

**Rule:** Writing `!` after a variable to assume the value is not empty is forbidden. Check the value explicitly.

**Why:** `!` turns off TypeScript's check. If the value really is empty, the error appears at runtime as a `TypeError` that does not say why. An explicit check throws the error by name.

**Example:**

```ts
// Wrong
return toJobDto(job!);

// Right (src/modules/jobs/jobs.service.ts)
if (!job) {
  throw new NotFoundError(JobErrorCode.JOB_NOT_FOUND, 'Job was not found.');
}
return toJobDto(job);
```

**Check:** Lint (`typescript/no-non-null-assertion`).

### CODE-10: Public methods declare their return type

**Rule:** Exported functions and the public methods of exported classes declare their return type explicitly. In private methods and internal functions, TypeScript infers the type.

**Why:** The return type of a method used by other modules does not change unnoticed because of a change inside the method. For example, if `UsersService.reserveCredits` starts returning a value by mistake, compilation fails. Writing types in internal functions makes the code longer and gives no benefit.

**Example:**

```ts
// src/modules/jobs/job-lifecycle.service.ts
async findClaimable(jobId: string): Promise<ClaimableJob | null> { ... }
```

**Check:** Lint (`typescript/explicit-module-boundary-types`).

## NestJS

### CODE-11: Data from outside is validated with zod

**Rule:** All data that comes from outside the process is validated with a zod schema before use. DTO and message types are derived from the schema. class-validator is not used.

| Data | Where |
|---|---|
| Request body, query and route parameters | Schema under `dto/`, `ZodValidationPipe` (`src/core/validation`) |
| Request headers | The guard or decorator that reads the header (`UserIdSchema` inside `UserIdGuard`; `ZodValidationPipe` inside `@IdempotencyKey()`) |
| Kafka message | Schema in the owning module's `messages/` folder, used by both the writer and the reader (`JobDispatchSchema` in `job-outbox/messages/job-dispatch.message.ts`). A message that cannot be parsed goes to the dead-letter topic. |
| Environment variables | `src/core/config/env.validation.ts`, `script-env.ts` for command-line tools |

**Why:** When validation happens once at the boundary, the code inside works with concrete types (CODE-08). The schema and the type are defined in one place and cannot drift apart. The OpenAPI document is also generated from the same schemas (`API_DOCUMENTATION_STANDARDS.md`, DOC-02), so what is validated is what is documented. The project has a single validation library.

**Example:**

```ts
// src/modules/jobs/dto/job.dto.ts
export const CreateJobSchema = z
  .strictObject({
    type: z.string().min(1).max(32).meta({ description: 'Job type.', example: 'summary' }),
    input: z.string().meta({ description: 'Text to process. ...', example: 'Merhaba dünya' }),
  })
  .meta({ id: 'CreateJob' });

export type CreateJobDto = z.infer<typeof CreateJobSchema>;

// src/modules/jobs/jobs.controller.ts
create(
  @UserId() userId: string,
  @IdempotencyKey() idempotencyKey: string,
  @Body(new ZodValidationPipe(CreateJobSchema)) body: CreateJobDto,
): Promise<JobCreatedDto> {
  return this.jobs.create({ userId, idempotencyKey, type: body.type, input: body.input });
}
```

**Check:** Code review.

### CODE-12: Feature module folder layout

**Rule:** Each feature module lives under `src/modules/<module>`. The module's files are in the folder root. Subfolders are created only for:

| Subfolder | Contents |
|---|---|
| `dto/` | Request and response schemas and DTO mapping functions |
| `messages/` | Kafka message schemas that other modules also read |
| A sub-feature | A few files that change together and that the rest of the module does not use. Today no module has one: a feature that grows its own table becomes its own module (ARCH-04), as the CSV export did (`job-exports`). |

If a module needs different parts in two processes, each part has its own NestJS module file (`job-outbox.module.ts`, `job-outbox-relay.module.ts`; ARCH-11). A unit test (`*.spec.ts`) and a test that runs a single class against a real database or Redis (`*.db-spec.ts`) sit next to the file they test. Endpoint tests and tests that exercise several modules together are under `test/` (`TESTING_STANDARDS.md`, TEST-01).

```
src/modules/jobs/
  jobs.module.ts
  job-lifecycle.module.ts
  jobs.controller.ts
  jobs.service.ts
  job-lifecycle.service.ts
  jobs.constants.ts
  jobs.errors.ts
  idempotency-key.decorator.ts
  dto/
    job.dto.ts
```

Subfolders and `.constants.ts`, `.errors.ts` files are created only if they have content. CODE-19 applies to where constants go.

**Why:** All modules use the same layout, so the location of a file is predictable. In a module with few files, a separate folder for each role (`handlers/`, `strategies/`) does not make files easier to find; it only makes paths longer. When the test file is next to the code, the two are updated together.

**Check:** Code review.

### CODE-13: Import paths

**Rule:**

- Imports are written with the `.ts` extension.
- Code in another top-level folder is reached with a path that starts with `#shared`, `#core`, `#infra`, `#modules` or `#generated`.
- Imports within the same module or the same `core`/`infra` folder use relative paths (`./`, `../`).
- Tests reach the helpers under `test/support` with relative paths, because there is no `#` path for `test/`.

**Why:** The source file's extension is `.ts`, so the imported path is the same as the file on disk. `#` paths do not break when a file moves, avoid long relative paths like `../../../`, and are the only form the ARCH-02 and ARCH-05 lint rules can see.

**Example:**

```ts
// From another folder
import { PrismaService } from '#infra/database/prisma.service.ts';
import { JobStatus } from '#generated/prisma/enums.ts';

// From within the same module
import { toJobListItemDto } from '../dto/job.dto.ts';
import { JOB_CSV_HEADER, toJobCsvLine } from './job-csv.ts';
```

**Check:** The TypeScript compiler. A relative import without an extension, or a `#` path that is not in the `package.json` `imports` field, fails compilation. Code review checks that imports across layers use a `#` path, not a relative one.

### CODE-14: Environment variables are read only inside src/core/config

**Rule:** `process.env` is read only inside `src/core/config`. Code that runs inside Nest reads environment variables with the typed `ConfigService<Env, true>`. Command-line tools that run outside Nest (`seed.ts`) read them with `loadScriptEnv()`. A new environment variable is first added to the zod schema under `src/core/config`.

**Exception:** Tool config files in the project root (`prisma.config.ts`) and test setup files (`test/support`).

**Why:** All values are validated with zod when the process starts. A missing or invalid value fails at startup, not at its first use. Code works with typed values, and a variable's default lives in one place.

**Example:**

```ts
// Right
constructor(config: ConfigService<Env, true>) {
  this.concurrency = config.get('WORKER_JOB_CONCURRENCY', { infer: true });
}

// Wrong
const concurrency = Number(process.env.WORKER_JOB_CONCURRENCY);
```

**Check:** Lint (`node/no-process-env`), turned off for `src/core/config/**` and `test/support/**`.

## Design principles

### CODE-15: Code that does the same thing is written in one place

**Rule:** There are no two methods, functions or code blocks that do the same thing. Before writing a new method, search the project for a method that already does it. If one exists, use or extend it. Choose the place for shared logic like this:

| Where the shared logic is used | Place |
|---|---|
| In several methods of the same class | A private method of the class |
| In several files of the same module | The module's service, or a file without a role in the module (`job-outcome.ts`) |
| In several modules, tied to a table or business rule | The service of the owning module (`ARCHITECTURE_STANDARDS.md`, ARCH-05 and ARCH-06) |
| In several modules, not tied to NestJS or data | A function under `src/shared` (`normalizeInput`, `contentHash`) |

This rule forbids writing the same knowledge in two places: the same business rule, calculation, decision logic, or a format both sides must follow. The writer and reader of a Kafka message using the same schema is an example. Two pieces of code that look alike but change for different reasons are not duplication. Example: the relay, the reconciler and the idempotency cleanup are each a timer loop, but the interval, error behavior and shutdown of each change for separate reasons. For such similarities, the rule of three in CODE-21 applies.

**Why:** If the same knowledge is written in two places, a change is made to only one, and the two start giving different results. For example, if the content hash (`contentHash`) were written separately in the API and in `seed.ts`, the same text would produce two different hashes, and seed data would not share results with real requests. That is why both use the `src/shared/job-content.ts` file. Such bugs are hard to spot in code review.

**Check:** Code review.

### CODE-16: Code follows the SOLID principles

**Rule:** Code follows the five SOLID principles. In this project each principle means:

| Principle | Meaning in this project |
|---|---|
| Single responsibility | A class has a single reason to change. That is why the worker flow is split into separate services: `JobResolverService` finds the outcome, `JobSettlementService` writes the outcome, `JobConsumerService` deals only with Kafka (ARCH-09). |
| Open-closed | Adding a new option does not require changing existing code. A new AI provider is a class that implements the `AiProvider` interface and one line in the `AI_PROVIDERS` list (CODE-18). |
| Liskov substitution | All implementations of an interface can replace each other. `ConcurrencyTrackingAiProvider` wraps any `AiProvider` and is itself an `AiProvider`. `ControllableAiProvider` in tests replaces the real provider. |
| Interface segregation | Interfaces are kept small. `AiProvider` has a single method (`generate`) and a name. A class is not forced to implement methods it does not use. |
| Dependency inversion | Classes with dependencies receive them through NestJS dependency injection. Plain objects without dependencies (error mappers, `FakeAiProvider`) may be created with `new` in the module's provider definition. Business code reaches external systems through our own types (`AiRequest`, `QueueMessage`), not the library's types (ARCH-12). |

**Why:** Code that follows these principles is made of small, independent parts. When one part changes, the others are not affected, and each part can be tested separately. Example: the processing flow does not depend on Kafka, so its end-to-end test runs without Kafka.

**Check:** Code review. Claude uses this table as a checklist before delivering the code it writes.

### CODE-17: Complexity limit

**Rule:** A function does not exceed these limits:

| Measure | Limit | Notes |
|---|---|---|
| Decision points | 9 | `if`, `case`, loops, `&&`, `\|\|`, `??` and `?:`. Lint sets cyclomatic complexity to 10, which is decision points + 1. |
| Nested blocks | 3 levels | |
| Length | 50 lines | Blank lines and comments are not counted. Test files have no length limit. |

No `else` follows an `if` block that ends with `return`. Use early exit instead of nested conditions.

**Why:** Code with many branches and deep nesting is hard to read and test. Each branch needs a separate test case. If the limit is exceeded, the function does more than one thing and should be split. Test files are exempt, because a `describe` block by definition contains many tests, and splitting it does not improve readability.

**Example:**

```ts
// Wrong
async get(userId: string, jobId: string): Promise<JobDto> {
  const job = await this.prisma.job.findFirst({ where: { id: jobId, user_id: userId } });
  if (job) {
    return toJobDto(job);
  } else {
    throw new NotFoundError(JobErrorCode.JOB_NOT_FOUND, 'Job was not found.');
  }
}

// Right
async get(userId: string, jobId: string): Promise<JobDto> {
  const job = await this.prisma.job.findFirst({ where: { id: jobId, user_id: userId } });
  if (!job) {
    throw new NotFoundError(JobErrorCode.JOB_NOT_FOUND, 'Job was not found.');
  }
  return toJobDto(job);
}
```

**Check:** Lint (`complexity`, `max-depth`, `max-lines-per-function`, `no-else-return`). `max-lines-per-function` is turned off for test files.

### CODE-18: Strategy for open-ended options, discriminated union for closed outcomes

**Rule:** When choosing a behavior based on a value, two cases are distinguished:

1. **If the options are open-ended** (new options are expected, and each option has its own dependency, state or external system), use the strategy pattern:
   - Define an interface for the behavior.
   - Each option is a separate class that implements this interface.
   - The classes are provided as a list under an injection token (`Symbol`), and a selector class finds the right one.
2. **If the options are a closed set** (like the possible outcomes of an operation, where adding a new value means changing the flow itself), express the outcome as a discriminated union type (with a `kind` field) and handle it in a single `switch`. The function's return type is declared, so a missing branch fails compilation.

For a simple choice between two options, an `if` is enough.

**Why:** The value of the strategy pattern is that a new option can be added without changing existing code (CODE-16, open-closed principle). This value is real when each option has a separate dependency: an AI provider has its own HTTP client, timeout and error codes. The outcomes of an operation (completed, permanent error, transient error, interrupted), on the other hand, must know about each other: they all write to the same tables in the same transaction, and their order matters. Splitting them into four classes spreads the flow across four files and gains nothing. A compiler-checked `switch` shows every place that does not handle a newly added outcome.

**Example:**

```ts
// 1. Strategy: src/infra/ai-provider
export interface AiProvider {
  readonly adapter: string;
  generate(request: AiRequest, signal: AbortSignal): Promise<AiResult>;
}

// ai-provider.module.ts
providers: [{ provide: AI_PROVIDERS, useFactory: () => [new FakeAiProvider()] }, AiProviderRegistry],

// ai-provider.registry.ts: job_providers.adapter → provider
constructor(@Inject(AI_PROVIDERS) providers: AiProvider[]) {
  this.providers = new Map(providers.map((p) => [p.adapter, new ConcurrencyTrackingAiProvider(p)]));
}
```

To add a real provider, write a class that implements `AiProvider` and add it to the `AI_PROVIDERS` list. `JobResolverService` does not change. The `PROBLEM_MAPPERS` list that builds error responses (`src/core/errors/problem-mapper.ts`) is a second example of the same pattern.

```ts
// 2. Discriminated union: src/modules/job-worker/job-outcome.ts
export type JobOutcome =
  | { kind: 'completed'; text: string; source: JobResultSource }
  | { kind: 'transient'; errorCode: string }
  | { kind: 'permanent'; errorCode: string }
  | { kind: 'interrupted'; reason: 'shutdown' | 'lease_lost' };

// job-settlement.service.ts
private apply(tx: Prisma.TransactionClient, settlement: Settlement): Promise<LogEntry> {
  const { outcome } = settlement;
  switch (outcome.kind) {
    case 'completed':
      return this.complete(tx, settlement, outcome.text, outcome.source);
    case 'permanent':
      return this.fail(tx, settlement, outcome.errorCode);
    ...
  }
}
```

**Check:** Code review.

### CODE-19: Meaningful strings and numbers are defined as constants

**Rule:** Meaningful string and number values in code (status, error code, event code, Kafka topic, cache field, timeout, attempt count, batch size) are not written directly in more than one place; they are used through a constant or a literal type. The place of a constant depends on who uses it:

| Who uses it | Place | Format |
|---|---|---|
| A single file | A non-exported `const` at the top of the file | UPPER_CASE (`CONSUMER_GROUP`, `REDIS_COMMAND_TIMEOUT_MS`) or a PascalCase `as const` list (`RedisLogEvent`) |
| Several files of the module | `<module>.constants.ts` | UPPER_CASE constant (`SETTLE_ATTEMPTS`) or a PascalCase `as const` list (CODE-06) |
| Error codes used only within the module | `<module>.errors.ts` (`JobErrorCode`) | `as const` list (`ERROR_AND_LOGGING_STANDARDS.md`, ERR-02) |
| Several modules (including error codes documented by another module) | The `.constants.ts` file of the module that owns the value (`UserErrorCode`, `JOB_DISPATCH_TOPIC`). Other modules may import only this file (ARCH-05). | |
| A closed list stored in the database that database rules depend on | Prisma enum (`DATABASE_STANDARDS.md`, DB-09) | |
| A list stored in the database that grows with the code | `VarChar` column; the values are in the `.constants.ts` file of the module that writes them (`JobFailureCode` in `job-worker.constants.ts` for `jobs.error_code`, DB-09) | PascalCase `as const` list (CODE-06) |
| The label of a closed set of outcomes | A literal in the discriminated union type (`kind: 'completed'`, CODE-18) | |

If the code does not show the reason for a value, write it next to the constant (`// The case: "Keys are valid for 24 hours."`).

**Exceptions:** These values may be written directly:

- Error descriptions (`detail`) and error messages
- Route paths (`@Controller('jobs')`)
- Import paths
- Test descriptions (`it('reserves the cost, queues the job and returns 202', ...)`)
- API values expected by tests (`status: 'queued'`, `code: 'IDEMPOTENCY_KEY_REUSED'`)

A log message is an event code and is defined as a constant (`JobLogEvent.JOB_CREATED`; `ERROR_AND_LOGGING_STANDARDS.md`, LOG-03).

**Why:** When the same string is written in several places, a typo in one of them is not caught at compile time. With a constant or literal type, a typo fails compilation and the value changes in one place. That is why literal types need no separate constant: if `kind: 'complted'` is written, TypeScript reports an error. Tests write API values explicitly on purpose: if a test used the constant from the source, then when the constant's value changed by mistake, the test would change with it and would not catch the change that breaks the client.

**Example:**

```ts
// job-outbox.constants.ts
export const JOB_DISPATCH_TOPIC = 'jobs.process';

// users.constants.ts: the jobs module documents these codes for POST /v1/jobs
export const UserErrorCode = {
  INSUFFICIENT_CREDITS: 'INSUFFICIENT_CREDITS',
  TOO_MANY_ACTIVE_JOBS: 'TOO_MANY_ACTIVE_JOBS',
} as const;

// Wrong
await consumer.start({ topic: 'jobs.process', ... });
if (job.status === 'queued') { ... }

// Right
await consumer.start({ topic: JOB_DISPATCH_TOPIC, ... });
if (job.status === JobStatus.queued) { ... }
```

**Check:** Code review. The `no-magic-numbers` lint rule is not enabled.

### CODE-21: The simplest solution for today's need

**Rule:** Code is written in the simplest form that meets today's need. Do not write code because "it may be needed later". This rule balances the rules from CODE-15 to CODE-18:

- **Do not write an interface with a single implementation or a base class with a single subclass.** An interface is written only if it has more than one implementation. In this project, `ProblemMapper` has an interface because it has four mappers. Tests do not need an interface to fake something: NestJS's `overrideProvider` method replaces the class or token directly.
  - **Exception: the ports of replaceable external systems.** The queue broker, the AI provider and the file store have ports (`src/infra/queue/queue.ts`, `src/infra/ai-provider/ai-provider.ts`, `src/infra/file-store/file-store.ts`) even though Kafka is the only broker, `FakeAiProvider` the only provider and a local directory the only file store today (ARCH-03, QUEUE-01). All three are external systems the product is expected to replace or add to (a real LLM; BullMQ or RabbitMQ at another scale; an object store such as S3 once instances stop sharing a disk), the boundary is already known (the worker needs only "publish", "consume and acknowledge", "generate text" and "write, open, delete a file"), and without a port the switch would touch every module that uses them. The exception covers only these three; it is not a reason to put an interface in front of the database, the cache or a service.
- **Do not add unused options.** Do not write a parameter, setting or extension point that no caller uses.
- **Rule of three.** Code that looks similar (not the knowledge duplication in CODE-15) may stay separate for the first two uses. On the third use it is extracted into shared code. It is hard to see the right abstraction from two examples, and a wrong abstraction costs more than duplication.
- **If rules conflict, choose the simpler one.** If both approaches follow the standards, choose the one with fewer files, classes and indirect steps. If the code does not show the reason for the choice, write it in a comment (CODE-05).

**Why:** Most abstractions written for future needs are never used, or turn out different from what was expected when the need arrives. Every unused layer is code that must be read, tested and changed. Extending simple code when the need appears is easier than undoing a wrong abstraction. Extracting an interface when a second implementation arrives takes a few minutes, because at that point two real implementations show what they have in common.

**Example:** The `BaseRedisClient` base class, which provided the logs for Redis connection loss and recovery and the shutdown, was written when there were two Redis instances, for cache and queue. When the queue moved to Kafka, it was left with a single subclass and was merged with `CacheRedisClient`.

```ts
// Wrong: base class with a single subclass
export abstract class BaseRedisClient extends Redis implements OnModuleDestroy { ... }
export class CacheRedisClient extends BaseRedisClient { ... }

// Right: a single class
@Injectable()
export class CacheRedisClient extends Redis implements OnModuleDestroy { ... }
```

**Check:** Code review.

## Development process

### CODE-20: Test first, then code

**Rule:** The test is written before a new service method or a new endpoint. The test is also updated before the behavior of a method or endpoint changes. The test type depends on what the behavior depends on (`TESTING_STANDARDS.md`, TEST-02 and TEST-04):

| What will be written | Test written first |
|---|---|
| Endpoint | Endpoint test (`test/*.e2e-spec.ts`). It defines the request sent, the HTTP status code returned, the response body and the state left in the database (balance, ledger, outbox record). |
| Service method whose result depends on SQL (conditional update, lock, constraint) | A test that runs on the real test database. Flows that exercise several modules together go under `test/` (`job-processing.e2e-spec.ts`); those for a single class go next to it (`*.db-spec.ts`). |
| Pure calculation or decision logic | Unit test (`*.spec.ts`), without external systems. Example: `job-outcome.spec.ts`, `job-route.spec.ts`. |

The order is:

1. Write the test.
2. Run the test and see it fail. It is expected to fail because the code is not written yet.
3. Write the code that makes the test pass.
4. Revise the code according to the rules from CODE-15 to CODE-19 and CODE-21. The test still passes.

The cases every endpoint test must cover are in TEST-03.

**Why:** The test makes clear what the request and the result will be before the code is written. Seeing it fail first proves that the test really exercises that behavior: a test that has never failed may be testing the wrong thing. In this project most of the correctness is in SQL (conditional updates, `SKIP LOCKED`, unique constraints). A test that fakes the database does not exercise these behaviors, so behaviors that depend on queries are tested with a real database.

**Example:**

```ts
// test/jobs.e2e-spec.ts
it('reserves the cost, queues the job and returns 202', async () => {
  await grant('user-1', 10);

  const response = await createJob('user-1', 'key-1').expect(HttpStatus.ACCEPTED);

  expect(response.body).toEqual({ jobId: expect.stringMatching(UUID), status: 'queued' });
  expect(await creditState('user-1')).toEqual({ balance: 7, reserved: 3, ledgerBalance: 7, ledgerReserved: 3 });
  expect(await testPrisma.jobOutboxMessage.count({ where: { job_id: response.body.jobId, sent_at: null } })).toBe(1);
});

it('rejects a job without enough credits with 402 and creates nothing', async () => { ... });
```

**Check:** Code review. If there is a new service method or endpoint, its test exists too.

### Before adding a new table

For work that needs a new table, the DB-13 rule in `DATABASE_STANDARDS.md` applies. No model is added to the schema until the table's scope is clear.

## Pending proposals

The items below are not rules yet. If approved, they will be added to the list above with an ID.

- **Interface names do not use an `I` prefix.** Write `AiProvider` instead of `IAiProvider`. The NestJS and TypeScript documentation do not use a prefix. Today's code follows this (`AiProvider`, `ProblemMapper`).
- **Use `async` and `await` instead of Promise chains.** Do not write `.then()` and `.catch()` chains. Today the code mostly uses `await`. Some places use chains for work started without awaiting: lease renewal (`job-run.ts`), Kafka offset commit (`kafka-queue-consumer.ts`).

## Technical details

This section explains why the settings are the way they are.

**Imports with the `.ts` extension:** `tsconfig.json` has `"rewriteRelativeImportExtensions": true`. When compiling, TypeScript changes the `.ts` extension in relative imports to `.js`. It does not rewrite paths that start with `#`. These paths are resolved by the `imports` field in `package.json`:

```json
"imports": {
  "#core/*.ts":      { "types": "./src/core/*.ts",          "default": "./dist/src/core/*.js" },
  "#infra/*.ts":     { "types": "./src/infra/*.ts",         "default": "./dist/src/infra/*.js" },
  "#modules/*.ts":   { "types": "./src/modules/*.ts",       "default": "./dist/src/modules/*.js" },
  "#shared/*.ts":    { "types": "./src/shared/*.ts",        "default": "./dist/src/shared/*.js" },
  "#generated/*.ts": { "types": "./prisma/generated/*.ts",  "default": "./dist/prisma/generated/*.js" }
}
```

TypeScript uses the `types` condition to read the source file. At runtime Node.js uses the `default` condition to load the compiled file.

**Vitest:** Vitest resolves the `imports` field to the compiled file, and tests fail if the `dist` folder does not exist. The `alias` list in `vitest.config.ts` points the `#core`, `#infra`, `#modules`, `#shared` and `#generated` paths to the source files.

**Prisma client:** `prisma/schema/schema.prisma` sets `importFileExtension = "ts"` and `moduleFormat = "esm"`. The generated client also uses imports with the `.ts` extension.

**Lint setting:** The rules are in `.oxlintrc.json` (oxlint 1.89, `--type-aware`). This file has the rules that check CODE-07, CODE-08, CODE-09, CODE-10, CODE-14 and CODE-17, plus `no-console` and `typescript/no-floating-promises`. The exceptions (`process.env` for `src/core/config` and `test/support`, `unknown` for the files in CODE-08, function length for test files) are defined by file path in the `overrides` section. Lint scans only the `src/` and `test/` folders.
