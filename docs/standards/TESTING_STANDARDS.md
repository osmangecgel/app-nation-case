# Testing Standards

This document defines the test types, where tests live, how they are written and the coverage threshold. Every rule has an ID (such as `TEST-01`). Use this ID to refer to a rule in code review.

The rule that tests are written before code is CODE-20 in `CODING_STANDARDS.md`. This document describes how tests are written.

To change a rule, open a PR that changes this file and write the reason in the PR description.

> **Status (1 November 2026):** The test groups, the test database, cleanup before every test, the manually answered provider and the three concurrency tests the case asks for are implemented. There are 239 unit tests and 134 database and flow tests. `scripts/verify.sh` runs the case's verification flow against the Docker Compose stack (the worker crash included, which the case does not require as an automated test). It also runs in a container with `docker compose run --rm verify all` (the `verify` service in the `tools` profile, with `test` and `seed`). The coverage threshold in `vitest.config.ts` is met (TEST-08). The classes that connect to Kafka are tested with a fake Kafka or a fake `QueuePublisher`; no automated test runs through a real Kafka broker. That path is verified by the verification run (TEST-01).

## Rule summary

| ID | Rule |
|---|---|
| TEST-01 | There are three test types: unit test, database test and flow test. Each has a fixed location and command. |
| TEST-02 | For a new endpoint or worker behavior, a flow test is written first; for a new calculation, a unit test is written first. |
| TEST-03 | Every endpoint test covers the successful request, invalid data and each business error of the endpoint. |
| TEST-04 | A rule is tested where it runs: a rule in SQL with the real database, a pure calculation with a unit test. Fakes are used only at external boundaries. |
| TEST-05 | Test data is created through the system's own entry points. Writing to the database directly is only for states the system reaches over time or after a crash. |
| TEST-06 | Every test starts with an empty database and is independent of other tests. Time moves on a clock the test controls. |
| TEST-07 | Test descriptions are in English. Each test checks one behavior and is written in arrange, act, assert order. |
| TEST-08 | Coverage is at least 80% on every metric. |
| TEST-09 | Concurrency rules are tested with calls that are really sent at the same time, and the consistency of the resulting data is checked. |
| TEST-10 | A test that sometimes passes and sometimes fails is investigated. It is not hidden with retries or long waits. |

## Test types

### TEST-01: Three test types

**Rule:**

| Type | What it tests | File | Command | Needs services |
|---|---|---|---|---|
| Unit test | The logic of a single class or function. No database, Redis or Kafka. | Next to the file it tests, `*.spec.ts` | `npm test` | No |
| Database test | A single class working with real PostgreSQL or Redis: an `infra` class, or a service method whose result depends on SQL (CODE-12, CODE-20) | Next to the file it tests, `*.db-spec.ts` | `npm run test:e2e` | Yes |
| Flow test | The full path of a request or a job, with all modules together | In the `test/` folder, `*.e2e-spec.ts` | `npm run test:e2e` | Yes |

A flow test has two entry points:

- **HTTP:** The test starts the application with the same HTTP setup as `main.ts` (`test/support/test-app.ts`) and sends real requests. This test is called an "endpoint test" (`test/jobs.e2e-spec.ts`).
- **Worker:** The test calls the worker's method that processes a job (`JobProcessorService.process`) directly. Kafka is not involved (`test/job-processing.e2e-spec.ts`).

Unit tests run in the `unit` group; the other two run in the `db` group. The `db` group uses a separate test database (`app_nation_case_test`) and Redis DB index 1. It does not touch development data. `npm run db:up` is required first. Tests do not connect to Kafka.

The same suite runs inside Docker with `docker compose run --rm test`, so a reviewer needs neither Node.js nor npm: the `Dockerfile`'s `test` stage holds the source and the development packages, and the `test` service points the tests at the compose services (`POSTGRES_HOST=postgres`, `CACHE_REDIS_HOST=cache-redis`; `test/support/test-env.ts` falls back to `localhost` and the published ports).

**Why:** Unit tests run in milliseconds, so they are run often during development. Tests that need real services are in a separate group, so `npm test` runs without any services.

Kafka was left out of the tests on purpose. Whether a message reaches the worker depends on partition assignment and on the consumer group being ready. These timings vary from machine to machine, and the test then sometimes passes and sometimes fails. On the Kafka side, the decision logic we wrote (when to commit the offset, the wait after a failed message) is in the `KafkaQueueConsumer` class. This class is tested in a unit test with a fake Kafka to which the test hands messages manually (`src/infra/queue/kafka/kafka-queue-consumer.spec.ts`). The rest of the Kafka side is tested the same way, without a broker: `KafkaQueuePublisher` with a fake Kafka client (`kafka-queue-publisher.spec.ts`), `JobConsumerService` with its collaborators replaced (`src/modules/job-worker/job-consumer.service.spec.ts`), and `JobOutboxRelayService` on the real test database with a fake `QueuePublisher` (`test/job-outbox-relay.e2e-spec.ts`). Only the path through a real Kafka broker has no automated test; it runs in the verification run (`scripts/verify.sh`).

**Example:**

```
src/modules/job-worker/
  job-outcome.ts
  job-outcome.spec.ts                npm test          (retry delay calculation)
src/infra/cache/
  cache.service.ts
  cache.service.db-spec.ts           npm run test:e2e  (lock with real Redis)
test/
  jobs.e2e-spec.ts                   npm run test:e2e  (HTTP request)
  job-processing.e2e-spec.ts         npm run test:e2e  (worker processes a job)
```

**Check:** Test config (`vitest.config.ts`). If the file name is wrong, the test runs in no group.

### TEST-02: Which test is written first

**Rule:** The "test first" order in CODE-20 is applied like this:

- **A new endpoint:** The endpoint test is written first. The test defines the request and the expected response. It is run while the code does not exist yet, and it is seen to fail.
- **A new worker behavior** (for example, a job returning to the queue after a transient error): A flow test is written first in `test/job-processing.e2e-spec.ts`, stating what will be in the database when the job ends.
- **A pure calculation** (delay, routing, masking): A unit test is written first.
- Then the code is written and completed until the tests pass.

**Why:** A flow test fixes, before the code exists, the response the client will see and the result left in the database. However the code is split later, this test does not change. A unit test, on the other hand, covers every case of a calculation quickly and cheaply.

**Check:** Code review.

## Coverage and method

### TEST-03: Minimum coverage of an endpoint test

**Rule:** For each endpoint, at least these tests are written:

| Case | Example (`POST /v1/jobs`) |
|---|---|
| Successful request: status code, response body and the result in the database | 202, `{ jobId, status: 'queued' }`, credits reserved, an unsent message in the outbox |
| Invalid data: 400, `VALIDATION_FAILED` and the invalid field | `input` missing: `REQUIRED` for `input` |
| Every business error the endpoint can throw | Not enough credits: 402 `INSUFFICIENT_CREDITS`. Same key with a different body: 422 `IDEMPOTENCY_KEY_REUSED`. Too many unfinished jobs: 429 `TOO_MANY_ACTIVE_JOBS`. No `X-User-Id`: 401 `USER_ID_REQUIRED`. |
| A missing record, for an endpoint that takes a record ID | `GET /v1/jobs/{id}`: 404 `JOB_NOT_FOUND` for a nonexistent ID, a malformed ID and another user's job |

For a successful request, the response alone is not checked. The result the endpoint leaves in the database is also checked. For a rejected request, the test checks that nothing was written (for a request that gets 402, the `jobs` table is empty).

The other cases of the business rule (boundary values, calculation details) are covered in unit tests or database tests.

**Why:** Every response type a client can encounter is exercised at least once with a real HTTP request. The error list in the endpoint's `@ApiEndpoint` (`API_DOCUMENTATION_STANDARDS.md`, DOC-04) and its tests cover the same errors. The response can be right while the database is wrong: a request that returns 202 but does not reserve credits passes a test that looks only at the response.

**Check:** Code review.

### TEST-04: A rule is tested where it runs

**Rule:**

- **Real database:** In this project the credit and idempotency rules are the SQL statements themselves. For example, the rule "reject if the balance is not enough" is a single `UPDATE` with the condition `balance >= cost` (`DATABASE_STANDARDS.md`, DB-14). Such rules are tested with real PostgreSQL, in a flow test or a database test. The same applies to Redis commands (acquiring and releasing a lock).
- **Unit test:** Calculations that do not touch the database are tested in unit tests: the retry delay (`job-outcome.spec.ts`), the routing of a job type (`job-route.spec.ts`), masking (`mask.spec.ts`), Kafka offset tracking (`partition-progress.spec.ts`).
- **Fake:** Used only at external boundaries that we do not control and whose timing the test cannot set:
  - **AI provider:** `test/support/controllable-ai-provider.ts`. Incoming calls wait until the test says `respond()` or `fail()`. The test itself decides when the provider answers and with what. Calls are counted in the `calls` list.
  - **Kafka:** `fakeKafka` in `kafka-queue-consumer.spec.ts` (the test hands over messages and partition changes manually) and in `kafka-queue-publisher.spec.ts` (the test reads the batches sent). In `test/job-outbox-relay.e2e-spec.ts`, the `QueuePublisher` port is replaced with a fake that records the published messages or fails when the test says Kafka is down.
  - **A dependency failing:** If the subject of the test is a dependency failing (for example, what `HealthService` returns when the database is unreachable), the dependency is replaced with a fake object provided with `useValue` in the NestJS test module.

**Why:** A fake shows that the code calls a method, but it cannot show that the method returns the right result. When the rule itself is in SQL, a test written with a fake database passes without ever running the rule. Only real PostgreSQL and its row locks show whether two requests can spend the same credits at the same time.

At an external boundary the opposite holds. The real fake provider (`FakeAiProvider`) waits between 500 ms and 5 seconds. A test written with this wait is slow and also leaves the notion of "at the same time" to the speed of the machine. With the manually answered provider, the test sets up a case such as "20 jobs are waiting and the provider answers once" the same way on every run.

**Example:**

```ts
// Unit test: no database, only the calculation
it('doubles the delay after attempt %i', (attemptCount, expected) => {
  expect(retryDelayMs(attemptCount, 1_000, 250, 0)).toBe(expected);
});
```

```ts
// Flow test: the provider is answered manually
const done = processor.process(jobId, REQUEST_ID);
await waitFor(() => provider.pending === 1);

provider.respond();
await done;

expect(await job(jobId)).toMatchObject({ status: 'completed', result_source: 'provider' });
```

**Check:** Code review.

### TEST-05: Test data is created through the system's own entry points

**Rule:**

- Test data is created with the application's own endpoints or services. To give a user credits, use `POST /internal/users/:id/credits` or `UsersService.grantCredits`; to create a job, use `POST /v1/jobs` or `JobsService.create`.
- Writing to the database directly (`testPrisma` in `test/support/test-prisma.ts`) is only for setting up states the system reaches over time or after a crash: an expired lock (a worker that died while running), a job that has not been claimed for a long time, a retry time. These writes set time based on the database clock (TEST-06).
- Tests can also look at the database directly when reading data. `creditState` in `test/support/credits.ts` returns the user's counters side by side with the values recomputed from the ledger records.
- No fixed starting data set shared by all tests is used. The only exception is the job type settings (`job_types`, `job_providers`, `job_type_routes`). These rows come from a migration, as in production, and are not deleted during cleanup.
- User IDs are readable values such as `user-1`, `user-2`. Real personal data is not used.

**Why:** In this project, a user's balance must always equal the sum of the records in the ledger. A helper function that writes a user directly to the table can produce a balance without a ledger record. A test that runs with this state, which the system would never produce, verifies something wrong. A test that grants credits through the real endpoint also builds the ledger correctly. And when the credit granting code changes, the tests follow the new code on their own.

This is why no separate test data factory (`test/factories`) was written. The only place where writing to the table directly is needed is simulating the passing of time or a crash. That is done in each test with an `UPDATE` of a few lines.

**Example:**

```ts
// Correct: credits are granted through the real endpoint, the ledger record is created too
await grant('user-1', 10);

// Correct: the state left by a worker that died while running, using the database clock
await testPrisma.$executeRaw`
  UPDATE jobs SET status = 'processing', lock_token = gen_random_uuid(),
                  locked_until = now() - interval '1 second'
   WHERE id = ${jobId}::uuid`;

// Wrong: a balance without a ledger record
await testPrisma.user.create({ data: { id: 'user-1', balance: 10 } });
```

**Check:** Code review.

### TEST-06: Tests are independent of each other

**Rule:**

- Before every test, all database tables are emptied. The job type settings tables and the migration table are kept (TEST-05). Each test creates the records it needs itself.
- The test Redis (DB index 1) is flushed before every test.
- Test files in the `db` group run one after another, not at the same time, because they all use the same test database.
- A test does not rely on data created by another test or on the order in which tests run.
- The application can be started once for the tests in a file (`beforeAll`). In that case, test objects that keep state in memory (for example, the call list of the manually answered provider) are reset before every test (`provider.reset()`).
- Time moves on a clock the test controls:
  - **In a unit test** the clock is a fake clock (`vi.useFakeTimers`, `vi.advanceTimersByTimeAsync`). The test skips past a 5-second wait without actually waiting (`fake-ai-provider.spec.ts`).
  - **In a flow test** the database clock cannot be stopped. A time-dependent state is set up by writing column values relative to the database's `now()`. They are not written with the application clock (`Date.now()`) (`QUEUE_STANDARDS.md`, QUEUE-16).
  - To wait for a condition, the test does not wait for a fixed time. `waitFor` checks at short intervals until the condition holds, and fails the test if it does not hold within 5 seconds. A fixed-time wait is used only when the code itself runs on a timer, and its duration is derived from that timer (for example, the polling interval of a job waiting for another worker's call).

**Why:** Tests that depend on each other break when their order changes or when they are run alone. Such failures are hard to find because they sometimes appear and sometimes do not.

There are two clocks for time: the application clock and the database clock. They can differ by milliseconds. If a test does not set up time with the clock the code compares against, this difference makes the test sometimes pass and sometimes fail. In this project such a test exposed a real bug (TEST-10).

**Check:** Test infrastructure (`test/support/reset-database.ts`, `test/support/global-setup.ts`, `fileParallelism: false` in `vitest.config.ts`).

### TEST-07: Writing style

**Rule:**

- The outermost `describe` is the name of a feature (`'Jobs API'`, `'Job processing'`) or a class (`'CacheService'`). The tests of one endpoint are grouped in a nested `describe`: `'POST /v1/jobs'`. Tests that check a behavior shared across several endpoints use the behavior's name and the related rule ID: `'Rate limiting (API-09)'`.
- The `it` description is an English sentence that states the behavior and its condition: `rejects a job without enough credits with 402 and creates nothing`.
- Each test checks one behavior. Two behaviors are two tests. Several outcomes of one behavior (response, balance, ledger) are checked in the same test.
- A test has three parts, separated by blank lines: arrange, act, assert.
- Values the client sees (error code, the `error` field, a status value) are written as literal strings in endpoint tests: `'INSUFFICIENT_CREDITS'`, `'queued'`. The constant from the code (`UserErrorCode.INSUFFICIENT_CREDITS`) is not used. `HttpStatus` is used for HTTP status codes.
- Every test contains at least one `expect`.

**Why:** When a test fails, its description tells what broke. In a test that checks one behavior, there is no need to search for where the failure is.

Error codes do not change once published (ERR-02). If a test uses the constant from the code, then when someone changes the constant's value, the test reads the same value and passes. The client, which expects the old code, breaks. A test that writes the code as a literal string catches this change. `HttpStatus` values, on the other hand, are the fixed numbers of the HTTP standard; they do not change.

**Example:**

```ts
describe('POST /v1/jobs', () => {
  it('rejects a job without enough credits with 402 and creates nothing', async () => {
    await grant('user-1', 2);

    const response = await createJob('user-1', 'key-1').expect(HttpStatus.PAYMENT_REQUIRED);

    expect(response.body).toMatchObject({ code: 'INSUFFICIENT_CREDITS', error: 'insufficient_credits' });
    expect(await testPrisma.job.count()).toBe(0);
  });
});
```

**Check:** Code review.

### TEST-08: Coverage threshold

**Rule:**

- `npm run test:cov` runs the unit, database and flow tests together and measures coverage. Coverage shows how much of the code ran at least once while the tests were running.
- Line, statement, function and branch coverage are each at least 80%. If one drops below, the command fails.
- Excluded: the entry scripts `main.ts`, `worker.ts`, `seed.ts` and `generate-openapi.ts`, `*.module.ts` files that only wire modules together, and test files.

Coverage alone is not enough. A test that checks nothing also raises coverage. This is why the TEST-07 rule "every test contains at least one `expect`" applies.

**Why:** Coverage does not show that code works correctly. What it shows is where the code is that no test has ever run. 80% is high enough to force every important file to be run by at least one test, and low enough not to cause meaningless tests written only to raise the number.

Code that only runs against a real Kafka broker (the connection itself, TEST-01) is verified by the verification run, but it appears as not run in the coverage report.

**Check:** `npm run test:cov`. The threshold and the excluded files are in `vitest.config.ts`. Last measured on 31 October 2026, the threshold is met: statements 94.14%, branches 81.84%, functions 94.8%, lines 94.08%.

### TEST-09: Concurrency tests

**Rule:** Every rule about "two requests arriving at the same time" is tested by really sending the requests at the same time (`Promise.all`). The test does not look only at the responses. It also checks the state left in the database at the end: the number of jobs created, the ledger records, and the balance matching the ledger (`creditState`).

The three tests the case asks for are examples of this rule:

| Test | File | What is done | What is expected |
|---|---|---|---|
| (a) 10 concurrent requests with the same key | `test/jobs.e2e-spec.ts` | 10 `POST /v1/jobs` with the same `Idempotency-Key` | All 202 with the same `jobId`. 1 job, 1 `reserve` record, balance 7. |
| (b) 5 concurrent requests of 3 credits each with a balance of 5 | `test/jobs.e2e-spec.ts` | 5 `POST /v1/jobs` with different keys | One 202, four 402. Balance 2, reserved 3, both equal to the ledger. |
| (c) 20 jobs with the same input | `test/job-processing.e2e-spec.ts` | 20 jobs are created, all 20 are processed at the same time, the provider is answered once | The provider was called once. 20 jobs `completed`, 20 `capture` records. |

**Why:** A concurrency bug happens in the gap of a few milliseconds between two operations. Requests sent one after another never create this gap, and the test cannot see the bug. The bug often does not show in the response: both requests can get 202 and spend the same credits twice. This is why the resulting data is checked. The balance equaling the sum of the ledger records catches every money-related bug in a single equality.

**Check:** Code review. A change that alters a concurrency rule is not merged without changing one of these tests or adding a new one.

## Flaky tests

### TEST-10: A flaky test is investigated

**Rule:** A test that sometimes passes and sometimes fails is investigated until the cause is found. These are not done:

- Running the test with a retry setting (`retry`).
- Extending a wait or a timeout without knowing the cause.
- Skipping the test (`it.skip`) or deleting it.

If the cause is in the environment (for example, Docker slowed down), this is shown with evidence and the environment is fixed. If the cause is in the code, the bug is fixed and the test stays as a test that catches a recurrence of the bug.

**Why:** A flaky test says that something depends on the order of two clocks, two operations or two processes. This order changes in production too. A test that passes with retries carries the bug to production.

There were two examples in this project:

- **A real bug:** The worker was seen to sometimes not take a new job. The cause: the job's `run_after` value was written with the API's clock, while the worker compared it with the database clock. When the API's clock was a few milliseconds ahead, the job was skipped as "not due yet" and was processed only in the reconciler's next round. The code was fixed: `run_after` is not checked for a job that has never been attempted. The test `takes a new job even when the API's clock is ahead of the database's` sets up this case on every run.
- **An environment problem:** When Docker Desktop slowed down, tests timed out on the database connection. The cause was not in the tests or the code but in Docker's state. No change was made to the code, and the timeouts were not extended. Once the environment recovered, the same tests passed unchanged.

**Check:** Code review. There is no `retry` setting in `vitest.config.ts`.

## Technical details

This section is for anyone who will change the test infrastructure.

**Groups:** `vitest.config.ts` defines two projects: `unit` and `db`. The two groups are in a single config file so that coverage can be measured together. `npm test` runs only `unit`, `npm run test:e2e` only `db`, and `npm run test:cov` both together.

**Test database:** Before the `db` group starts, `test/support/global-setup.ts` creates the test database if it does not exist, applies the migrations with `prisma migrate deploy` and flushes the test Redis. `test/support/reset-database.ts` empties the tables and runs `FLUSHDB` in Redis before every test. The test environment values are in `test/support/test-env.ts` and replace the values in the `.env` file. Only the port and database user details are taken from `.env`, so the developer's settings do not change how the tests behave. The background loops (outbox relay, reconciler) are set to a one-hour interval in tests, so they do not run on their own. Tests call them directly (`JobReconcilerService.reconcile`).

**Worker tests:** `test/job-processing.e2e-spec.ts` starts `AppModule` and `JobProcessingModule` together and replaces the provider list (`AI_PROVIDERS`) with the manually answered provider. `JobProcessingModule` does not include Kafka. Tests hand the worker the job it would take from Kafka through `JobProcessorService.process`.

**Decorator-generated branches:** In every NestJS class that takes dependencies in its constructor, the code TypeScript generates for decorators is counted as a branch, and no test can run that branch. If branch coverage drops below 80%, first check whether the missing branches are real or decorator-generated.

**Type checking:** Vitest runs tests without type checking. Type errors in test files show up only with `npm run typecheck`.
