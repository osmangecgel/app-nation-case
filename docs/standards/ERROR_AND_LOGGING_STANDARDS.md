# Error and Logging Standards

This document covers two topics. The log rules make it possible to trace from the logs everything a request and a job do, from the API to the worker. The error rules define the format of the API's error responses and how a job ends with an error in the worker. Log rule IDs start with `LOG`, error rule IDs with `ERR`. Use this ID to refer to a rule in code review.

To change a rule, open a PR that changes this file and write the reason in the PR description.

> **Status (31 October 2026):** The logger, `requestId`, masking, request logs, query logs, error classes and the exception filter are applied. The worker adds `jobId` and the `requestId` of the request that created the job to every line of a job. Logs are written only to standard output; the repo has no log collection service. Not applied yet: adding `userId` to every line automatically (no authentication). Some events pass it as a data field (`CREDITS_GRANTED`, `JOB_EXPORT_*`).

## Rule summary

| ID | Rule |
|---|---|
| LOG-01 | Every request has a W3C-compatible `requestId` value, returned in the response with the `x-request-id` header. |
| LOG-02 | Every log line carries `requestId`; in the worker, every line of a job carries `jobId` and the `requestId` of the request that created the job. |
| LOG-03 | Logs are written with the NestJS `Logger`. The message is a fixed event code; data is given in separate fields with camelCase names. |
| LOG-04 | The log format is chosen with `LOG_FORMAT`: colored line (`pretty`) or JSON (`json`). |
| LOG-05 | The log level is chosen by the importance of the event. |
| LOG-06 | One entry line and one exit line are written for each request. Bodies are turned on with `LOG_HTTP_BODIES`. |
| LOG-07 | Sensitive fields and the user's content (the job's text and result) are always masked in logs. |
| LOG-08 | Database query logs are turned on with `LOG_DB_QUERIES`. Parameters are written only in the development environment. |
| LOG-09 | Logs are written only to standard output. Collecting and searching them is the job of the runtime environment. |
| ERR-01 | Error responses use the RFC 9457 Problem Details format and also carry a lowercase `error` field. |
| ERR-02 | Every error has an uppercase, unchanging `code` value. |
| ERR-03 | Services throw errors with our own error classes. |
| ERR-04 | Validation errors return 400, and every invalid field appears in the `errors` list. |
| ERR-05 | Unexpected errors return 500, and internal details are not written to the response. |
| ERR-06 | Prisma errors are translated into meaningful errors in the exception filter. |
| ERR-07 | Error messages are in English. The client chooses the text it shows the user by `code`. |
| ERR-08 | The stack trace is added to the response only if `ERROR_INCLUDE_STACK` is on. It cannot be turned on in production. |
| ERR-09 | In the worker, a job's error is not an HTTP error. Provider errors are split into transient and permanent, and the job ends with a lowercase `error_code`. |

## Environment variables

| Variable | Values | Default | Description |
|---|---|---|---|
| `LOG_LEVEL` | `fatal`, `error`, `warn`, `log`, `debug`, `verbose` | `log` | This level and more important levels are written. |
| `LOG_FORMAT` | `pretty`, `json` | `pretty` in development, `json` in other environments | LOG-04 |
| `LOG_HTTP_BODIES` | `true`, `false` | `false` | LOG-06 |
| `LOG_DB_QUERIES` | `true`, `false` | `false` | LOG-08 |
| `ERROR_INCLUDE_STACK` | `true`, `false` | `false` | ERR-08 |

These variables are defined in the zod schema under `src/core/config` (`CODING_STANDARDS.md`, CODE-14). The API and the worker read the same variables.

## Tracing

### LOG-01: Every request has a requestId value

**Rule:** If the incoming request has a W3C `traceparent` header, `requestId` is the trace id in that header. If the header is missing or invalid, a new `requestId` is generated. The value is a 32-character lowercase hexadecimal (hex) string. The API returns this value in every response with the `x-request-id` header. In error responses, it also appears in the body in the `requestId` field (ERR-01).

The value goes to the worker together with the job the request creates: it is written to the `request_id` column of the outbox row and carried in the `request_id` header of the Kafka message (`QUEUE_STANDARDS.md`, QUEUE-05). If a message arrives without the header, the worker generates a new `requestId`.

**Why:** All log lines of a request are found with a single value. If the user or the support team passes on the `x-request-id` value, the problematic request is found directly. Because the value has the W3C trace id format, a client that sends `traceparent` (or a load balancer in front of us) finds its own trace id in our logs too. If OpenTelemetry is added later, the same value is used and the log fields do not change.

**Example:**

```
Request:  traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
Log:      "requestId": "4bf92f3577b34da6a3ce929d0e0e4736"
Response: x-request-id: 4bf92f3577b34da6a3ce929d0e0e4736
```

**Check:** The infrastructure applies it to every request (`RequestIdMiddleware`).

### LOG-02: Every log line carries requestId, and a job's lines carry jobId

**Rule:** Every log line carries `requestId`; every line of a job also carries `jobId`. The infrastructure takes these fields from the context and adds them to the line itself. Code does not write again a field that is already in the context. An ID that is not in the context is written as data: the `jobId` of a newly created job in the API (`JOB_CREATED`), or an infrastructure error written in the worker after the context has closed (`JOB_PROCESSING_FAILED`).

| Field | When |
|---|---|
| `requestId` | In the API, on every line of the request. In the worker, the value of the request that created the job being processed (LOG-01). Each round of the outbox relay, the reconciler and idempotency key cleanup runs in its own context with a new value. Lines outside any request, job or round carry the process's own value, generated once at startup (`RequestContext`). |
| `jobId` | In the worker, on every line written while a job is processed: claiming the job, the provider call, query logs, writing the result. |
| `userId` | Not added automatically. The `X-User-Id` header is not authentication, so the infrastructure does not put it on every line. Some events pass it as a data field: `CREDITS_GRANTED` and `JOB_EXPORT_*` (`JOB_EXPORT_STARTED`, `JOB_EXPORT_FINISHED`, `JOB_EXPORT_ABORTED`, `JOB_EXPORT_FAILED`). When authentication is added, the infrastructure will write it on requests of a logged-in user. |
| `context` | On every line. The name of the class that writes the log, or a fixed label for lines not written by a class of their own: `HTTP` (request lines), `OpenAPI` (undocumented endpoint warning), `AiProvider:<adapter>` (provider calls), `Kafka` (the Kafka library's own lines). |

In the worker, each job runs in its own context (`JobProcessorService.process`). Every line written in this context, whatever class it comes from (the provider, `PrismaService`, `JobSettlementService`), carries the same `jobId` and `requestId` values. Every job the reconciler recovers is also processed in its own `jobId` context.

Lines not related to a request or a job do not carry `jobId`. Their `requestId` tells where they come from:

- A periodic round's lines (`OUTBOX_CLEANED_UP`, `IDEMPOTENCY_KEYS_CLEANED_UP`, `RECONCILER_FAILED`) carry the round's own value, so one search finds one round.
- The process's own events carry the per-process value: startup and shutdown (`WORKER_STARTED`, `WORKER_STOPPED`), consumer lifecycle, connection state (`REDIS_CONNECTION_LOST`), reloading of job type settings, and the Kafka library's lines (`KAFKA_CLIENT_ERROR`, `KAFKA_CLIENT_WARNING`, `KAFKA_CLIENT_INFO`, with the library's text in the `detail` field). One search finds all such lines of one process.
- A Kafka message that points to no job (`MESSAGE_INVALID`, with `partition` and `offset` fields) is searched by event code and the `context` field.

When the reconciler resends a job that died while running or was never claimed, it reuses the `requestId` of the request that created the job, read from the job's latest outbox row (`JobOutboxService.findRequestId`). It generates a new `requestId` only when outbox cleanup has already deleted the job's rows (1 hour after they were sent, `OUTBOX_RETENTION_MS`). Later lines of such a job carry the generated value, not the `requestId` of the first request. All lines of the job are still found by `jobId`.

**Why:** All lines of a request are found by `requestId`, and all attempts of a job by `jobId`. Because worker lines also carry the `requestId` of the request that created the job, the whole path of a request from the API to the worker is visible with a single search. Having the infrastructure add the fields makes it impossible for a developer to forget them. A line without `requestId` cannot be grouped with anything; a per-round or per-process value groups the lines that belong together, and it never matches an API request, because it is generated, not taken from one.

**Example:**

```json
{"level":"log","pid":1,"timestamp":1793393573000,"message":"JOB_CREATED","context":"JobsService","requestId":"aea0a6057e867be0a17166836f75adcf","jobId":"01a18e96-3cae-7818-a697-10b570c5a5b1","jobType":"summary"}
{"level":"log","pid":1,"timestamp":1793393573120,"message":"JOB_CLAIMED","context":"JobProcessorService","requestId":"aea0a6057e867be0a17166836f75adcf","jobId":"01a18e96-3cae-7818-a697-10b570c5a5b1","attempt":1}
```

The first line is from the API, the second from the worker. Both carry the same `requestId` value.

**Check:** The infrastructure applies it to every line (`AppLogger`, `RequestContext`). `request-context.spec.ts` and `app-logger.spec.ts` (the per-process `requestId`), `kafka-logger.spec.ts` (Kafka library lines).

## Writing logs

### LOG-03: Logs are written with the NestJS Logger

**Rule:** Each class creates a `Logger` with its own name. Lines not written by a class of their own use a fixed label as the name: `HTTP` (`HttpLoggingMiddleware`), `OpenAPI` (`configureHttp`), `AiProvider:<adapter>` (`ConcurrencyTrackingAiProvider`, one per provider), `Kafka` (`kafkaLogger`, which passes the Kafka library's own lines to the application logger as `KAFKA_CLIENT_*` event codes with the library's text in `detail`). `console.log` and similar calls are not used. The log message is an English event code written in uppercase with underscores (such as `JOB_CREATED`, `REQUEST_RECEIVED`). The event code comes from a constant (CODE-19). IDs and values are not written into the message; they are given as separate fields. Log field names are written in camelCase (`jobId`, `durationMs`), in the same format as API fields.

In the colored format, the event code is written right next to the context: `[JobsService][JOB_CREATED]`. In the JSON format, it stays as is in the `message` field. Lines NestJS writes itself (such as `Nest application successfully started`) are outside this rule, because their text is not in our code.

**Why:** Event codes can be grouped in logs and searched with a single word. Separate fields can be filtered in the log tool and masked (LOG-07). Text written inside the message cannot be masked. `console.log` lines do not carry `requestId` and do not follow the format. Because field names are camelCase as in the API, the same concept (`jobId`) is searched by the same name in the response and in the log.

**Example:**

```ts
export const JobLogEvent = {
  JOB_CREATED: 'JOB_CREATED',
} as const;

export class JobsService {
  private readonly logger = new Logger(JobsService.name);

  async create(command: CreateJobCommand): Promise<JobCreatedDto> {
    ...
    // Correct
    this.logger.log(JobLogEvent.JOB_CREATED, { jobId: result.jobId, jobType: command.type });

    // Wrong
    this.logger.log(`Job ${result.jobId} created for ${command.userId}`);
  }
}
```

**Check:** Lint (`no-console`) and code review.

### LOG-04: The log format is chosen with LOG_FORMAT

**Rule:** With `LOG_FORMAT=pretty`, each log line is written as a single line, colored by its level. With `LOG_FORMAT=json`, each line is an uncolored, single-line JSON object. If `LOG_FORMAT` is not given, `pretty` is used in the development environment and `json` in other environments. `docker-compose.yml` runs the API and the worker with `NODE_ENV=production` but with `LOG_FORMAT=pretty`, because this file is for local trials and the logs are read in the terminal.

**Why:** Colored lines are easy to read in the terminal during development. Log tools search JSON lines by splitting them into fields.

**Example:**

```
LOG_FORMAT=pretty
[Nest] 1  - 30.10.2026 20:52:53     LOG [JobsService][JOB_CREATED] { requestId: 'aea0a605...', jobId: '01a18e96-...', jobType: 'summary' }   (green)
[Nest] 1  - 30.10.2026 20:52:53    WARN [ProblemDetailsFilter][REQUEST_REJECTED] { requestId: '4bf92f35...', code: 'INSUFFICIENT_CREDITS', status: 402 }   (yellow)
[Nest] 1  - 30.10.2026 20:52:54   ERROR [ProblemDetailsFilter][REQUEST_FAILED] { requestId: '9ac1e2f0...', code: 'INTERNAL_ERROR', status: 500 }   (red)
```

**Check:** Infrastructure.

### LOG-05: The log level is chosen by the importance of the event

**Rule:**

| Level | When | Examples in this project |
|---|---|---|
| `fatal` | The application cannot keep running. | Our code does not write this level. If the database cannot be reached at startup, the process stops with an error. |
| `error` | An operation failed and may need intervention. The stack trace is written. | 5xx error response (`REQUEST_FAILED`), a message that points to no job (`MESSAGE_INVALID`), an unrecognized provider error (`PROVIDER_ERROR_UNEXPECTED`), a crash of a reconciler round |
| `warn` | A problem occurred, but the system continues on its own. The stack trace is not written. | 4xx error response (`REQUEST_REJECTED`), Redis unreachable, a message will be retried (`MESSAGE_RETRY_SCHEDULED`), a job whose lock expired returned to the queue (`JOB_LEASE_EXPIRED`), a failed provider call |
| `log` | An important business event or a request line | `JOB_CREATED`, `JOB_CLAIMED`, `JOB_COMPLETED`, `CREDITS_GRANTED`, request entry and exit lines |
| `debug` | Detail useful for debugging | Another worker claimed the job or it is not due yet (`JOB_CLAIM_SKIPPED`), job type settings loaded |
| `verbose` | Not used. | |

**Why:** If levels are used consistently, `error` lines show the events that really need attention. 4xx errors are the client's mistake. If they are written as `error`, real errors get lost in the crowd. Situations the system fixes on its own (a Redis outage, a retried job) become `warn`. These lines do not need intervention one by one, but a rising count points to a problem.

**Check:** Code review.

### LOG-06: An entry and an exit line for each request

**Rule:** The infrastructure writes two lines for each request. The entry line (`REQUEST_RECEIVED`) has the method and the path. Query parameters are separated from the path and written to the `query` field. The exit line (`RESPONSE_SENT`) has the method, the path, the HTTP status code and `durationMs` (duration in milliseconds). If the client drops the connection before the response is sent, a `REQUEST_ABORTED` line is written instead of the exit line. `/health` requests are not written.

With `LOG_HTTP_BODIES=true`, the request body is added to the entry line and the response body to the exit line. The default is `false`. Bodies are always masked (LOG-07). So the job's text (`input`) and result (`result`) are not written even when body logging is on. A body larger than 10 KB is not written; its size is written in the `bodyOmittedBytes` field instead. The body is not truncated, because truncated JSON text cannot be masked field by field. The bodies of file uploads (`multipart/form-data`) are not written.

**Why:** Entry and exit lines show every incoming request, its result and its duration. A slow endpoint is found by `durationMs`, failing requests by status code. Body logs may be needed while debugging, but they increase log volume and create a risk of carrying personal data. So they start off and are turned on with an environment variable.

**Example:**

```
LOG [HTTP][REQUEST_RECEIVED] { requestId: 'aea0a605...', method: 'POST', path: '/v1/jobs', body: { type: 'summary', input: '[MASKED]' } }
LOG [HTTP][RESPONSE_SENT] { requestId: 'aea0a605...', method: 'POST', path: '/v1/jobs', status: 202, durationMs: 45, body: { jobId: '01a18e96-...', status: 'queued' } }
```

**Check:** Infrastructure (`HttpLoggingMiddleware`).

### LOG-07: Sensitive fields and the user's content are always masked

**Rule:** The value of a field whose name contains a sensitive word is replaced with `[MASKED]` before it is written to the log. The field name is split into words (on `_`, `-`, `.`, spaces and case changes): variations such as `new_password`, `refreshToken` and `x-api-key` are caught too. Matching is case-insensitive and is done at every level of nested objects. Masking is applied to all log fields, including request and response bodies and URL query parameters.

| Type | Words |
|---|---|
| Words that are sensitive on their own | `password`, `passwd`, `passphrase`, `secret`, `token`, `otp`, `authorization`, `cookie`, `cvv` |
| The user's content | `input` (the job's text), `result` (the provider's answer) |
| Word pairs that are sensitive together | `api` + `key`, `private` + `key`, `access` + `key`, `card` + `number`, `national` + `id` |

The words are kept in `src/core/logging/logging.constants.ts`. A new type of sensitive field is added to this list as a word. Masking a harmless field by mistake (such as `token_count`) is acceptable; writing a sensitive value in clear is not.

Masking looks only at the field name, not inside the value. So the user's content is not put into a field with another name or into an error message. For example, a provider error is logged in the `reason` field. A provider adapter cleans the message of a provider that adds the incoming text to its error message before logging it.

**Why:** Many people on the team have access to logs, logs are kept for a long time, and they are often sent to another company's service. If passwords, tokens and personal data are written to logs in clear, all of these people and services see that data. This is also a risk under KVKK. The job's text and result are the user's own content and can contain any kind of personal information. For debugging, you look at the record in the database by `jobId`, not at the content itself.

There are two layers protecting content: body logging is off by default (LOG-06), and if it is turned on, `input` and `result` are masked. If one changes by mistake, the other protects.

**Example:**

```
body={"type":"summary","input":"[MASKED]"}
body={"jobId":"01a18e96-...","status":"completed","result":"[MASKED]"}
```

**Check:** The infrastructure applies it (`src/core/logging/mask.ts`). Whether the list is up to date and the content of error messages are checked in code review.

### LOG-08: Database query logs are turned on with LOG_DB_QUERIES

**Rule:** With `LOG_DB_QUERIES=true`, every query Prisma runs is written at `log` level. The line has the query, `durationMs` and the context fields (`requestId`, `jobId` in the worker). Query parameters (`params`) are written only when `NODE_ENV=development`.

Parameters come from Prisma as a single string and cannot be masked field by field (LOG-07). So in the development environment, the job's text also appears in the parameters. The development environment runs only with trial data.

**Why:** Slow or unexpected queries are visible while debugging. Because parameters carry personal data and the user's content, they are not written with any setting outside development.

**Example:**

```
LOG [PrismaService][DATABASE_QUERY] { requestId: 'aea0a605...', query: 'SELECT "public"."jobs"."id", ... FROM "public"."jobs" WHERE ("public"."jobs"."id" = $1 AND "public"."jobs"."user_id" = $2) LIMIT $3 OFFSET $4', durationMs: 3, params: '["01a18e96-...","user-1",1,0]' }
```

**Check:** Infrastructure (`PrismaService`).

### LOG-09: Logs are written to standard output

**Rule:** The API and the worker write their logs only to standard output. In production, with `LOG_FORMAT=json`, each line is a single JSON object. Collecting, storing and searching logs (such as Loki, CloudWatch, Datadog) is the job of the runtime environment. The repo has no log collection service.

**Why:** The application does not know which log tool is used. When the tool changes, the code does not change. Container platforms already collect standard output. If the application wrote to a log service itself, that service slowing down or crashing would also affect the application. The `requestId`, `jobId`, level and `context` fields in JSON lines are used as filters in every tool.

**Example searches:**

```
requestId = "aea0a6057e867be0a17166836f75adcf"   all lines of a request from the API to the worker
jobId = "01a18e96-3cae-7818-a697-10b570c5a5b1"    all attempts of a job
level = "error" and context = "JobSettlementService"
```

**Check:** Code review.

## Error responses

### ERR-01: Error responses use the RFC 9457 format

**Rule:** All error responses use the RFC 9457 Problem Details format and are returned with the `Content-Type: application/problem+json` header. The response has these fields:

| Field | Required | Description |
|---|---|---|
| `title` | Yes | The HTTP status text (`Bad Request`, `Not Found`). |
| `status` | Yes | The HTTP status code. |
| `detail` | Yes | An English description specific to this error. |
| `instance` | Yes | The path of the request (`/v1/jobs/0192f3a1-...`). |
| `code` | Yes | The unchanging code of the error (ERR-02). |
| `error` | Yes | The lowercase form of the `code` value (`insufficient_credits` for `INSUFFICIENT_CREDITS`). |
| `requestId` | Yes | The `requestId` value of the request (LOG-01). |
| `errors` | No | Field-level errors (ERR-04). |
| `stack` | No | Only when `ERROR_INCLUDE_STACK=true` (ERR-08). |

`error` and `requestId` are extension members that RFC 9457 allows. Field names are camelCase like the rest of the API (`API_STANDARDS.md`, API-05). The `type` field from RFC 9457 is not used. Under the RFC, when `type` is omitted the error has no specific type and `title` is the HTTP status text. Errors are told apart by the `code` field.

**Why:** RFC 9457 is the IETF standard for HTTP API errors. The client handles all errors in one format. Thanks to `requestId`, the logs of every error response are found directly. The `error` field is for compatibility with clients that expect the error code in lowercase (`{ "error": "insufficient_credits" }`). Because its value is derived from `code`, it is not defined separately, and the two fields cannot drift apart.

**Example:**

```json
{
  "title": "Not Found",
  "status": 404,
  "detail": "Job was not found.",
  "instance": "/v1/jobs/0192f3a1-7c4e-7b2a-9d1f-3e5a8b6c2d10",
  "code": "JOB_NOT_FOUND",
  "error": "job_not_found",
  "requestId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

**Check:** The exception filter (`ProblemDetailsFilter`) converts all errors to this format.

### ERR-02: Every error has an unchanging code value

**Rule:** Error codes are written in uppercase, with words separated by underscores. The code describes the error in a way that a client who does not know the module name also understands (`INSUFFICIENT_CREDITS`). Every code is unique in the project: the same code is not used with two different meanings. A code is not changed after it is published.

Common codes are in the `CommonErrorCode` object in `src/core/errors/error-codes.ts`. A module's codes are in that module's `<Module>ErrorCode` object (`CODING_STANDARDS.md`, CODE-06 and CODE-19). The object lives in the `<module>.errors.ts` file. If another module also uses the codes (for example, `POST /v1/jobs` documents the user module's errors), the object lives in the `<module>.constants.ts` file, because another module can import only this file (`ARCHITECTURE_STANDARDS.md`, ARCH-05).

**Common codes:**

| Code | HTTP | When |
|---|---|---|
| `INVALID_JSON` | 400 | The request body is not valid JSON. |
| `VALIDATION_FAILED` | 400 | One or more fields are missing or invalid. |
| `UNAUTHORIZED` | 401 | Not logged in or the token is invalid. Will be used when authentication is added. |
| `FORBIDDEN` | 403 | The user is not allowed to perform this operation. |
| `NOT_FOUND` | 404 | The route was not found. |
| `CONFLICT` | 409 | The record already exists, or the request conflicted with another request arriving at the same time. |
| `PAYLOAD_TOO_LARGE` | 413 | The request body is larger than the allowed size. |
| `TOO_MANY_REQUESTS` | 429 | The rate limit was exceeded (`API_STANDARDS.md`, API-09). |
| `INTERNAL_ERROR` | 500 | Unexpected error. |

For 4xx errors that are not in the table and that NestJS throws itself, the code is derived from the HTTP status text: `METHOD_NOT_ALLOWED` for 405, `UNSUPPORTED_MEDIA_TYPE` for 415.

**Business errors in this project:**

| Code | HTTP | Where defined | When |
|---|---|---|---|
| `USER_ID_REQUIRED` | 401 | `AuthErrorCode` | The `X-User-Id` header is missing or invalid. |
| `INSUFFICIENT_CREDITS` | 402 | `UserErrorCode` | The balance does not cover the job's price. |
| `JOB_NOT_FOUND` | 404 | `JobErrorCode` | The job does not exist, the ID is malformed, or the job belongs to another user. |
| `IDEMPOTENCY_KEY_REUSED` | 422 | `JobIdempotencyErrorCode` | The same `Idempotency-Key` was sent with a different body. |
| `BALANCE_LIMIT_EXCEEDED` | 422 | `UserErrorCode` | A credit grant would take the user's balance plus reserved credits past 2,147,483,647 (`MAX_USER_CREDITS`, the INTEGER maximum). Nothing is written. |
| `TOO_MANY_ACTIVE_JOBS` | 429 | `UserErrorCode` | The user's number of unfinished jobs is at the limit. |

**Why:** The client chooses the text it shows the user and the reaction it gives by the `code` value (ERR-07). If the code changes, the translation and checks in the client break.

Codes do not start with the module name. The module is where the code lives on our side. It has no meaning for the client, and the code must not change when it moves from one module to another. Which module a code belongs to is found from the `<Module>ErrorCode` object that defines it.

**Check:** Code review.

### ERR-03: Services throw our own error classes

**Rule:** On error, services throw the error classes under `src/core/errors`. NestJS `HttpException` classes are not used in services. Each class maps to one HTTP status code.

| Class | HTTP | When | In this project |
|---|---|---|---|
| `ValidationError` | 400 | Incoming data is invalid. | `ZodValidationPipe` |
| `UnauthorizedError` | 401 | Identity could not be determined. | `UserIdGuard` |
| `PaymentRequiredError` | 402 | Not enough credits for the operation. | `INSUFFICIENT_CREDITS` |
| `NotFoundError` | 404 | The requested record does not exist. | `JOB_NOT_FOUND` |
| `ConflictError` | 409 | The record already exists, or a concurrent change conflicted. | Two requests arriving at the same time conflicted despite retries |
| `BusinessRuleError` | 422 | The data is valid, but a business rule does not allow the operation. | `IDEMPOTENCY_KEY_REUSED`, `BALANCE_LIMIT_EXCEEDED` |
| `TooManyRequestsError` | 429 | The user reached a limit. | `TOO_MANY_ACTIVE_JOBS` |

**Why:** The error class carries the HTTP status, the code and the detail in one place. The exception filter converts each class to a response in the same way. Service code does not depend on HTTP. `UsersService` is called from both the API and the worker and knows nothing about HTTP.

**Example:**

```ts
const job = await this.prisma.job.findFirst({ where: { id: jobId, user_id: userId }, select: JOB_DETAIL_SELECT });
if (!job) {
  throw new NotFoundError(JobErrorCode.JOB_NOT_FOUND, 'Job was not found.');
}
```

**Check:** Code review. `HttpException` errors that NestJS throws itself (for example, a route that is not found) are also converted to the ERR-01 format in the exception filter.

### ERR-04: Validation errors are returned per field

**Rule:** A validation error returns status code 400 and the `VALIDATION_FAILED` code. Each invalid field is a separate item in the `errors` list. If a field has more than one error, each error is a separate item.

| Field | Description |
|---|---|
| `field` | The path of the field. Nested fields are written with dots, array elements by index (`items.0.quantity`). Body fields are camelCase as in the DTO. For header errors, the name of the header is written (`Idempotency-Key`). |
| `code` | The code of the field error. |
| `message` | English description. |

**Field error codes:**

| Code | When |
|---|---|
| `REQUIRED` | A required field was not sent. |
| `INVALID_TYPE` | The field's type is wrong (such as text instead of a number). |
| `INVALID_FORMAT` | The format is wrong (such as UUID, date). |
| `INVALID_VALUE` | The value is not one of the allowed values (such as an unknown job type, or an `input` containing the NUL character `\u0000`, which PostgreSQL text cannot store). |
| `TOO_SMALL` | The value or length is below the lower limit (such as an empty `input`). |
| `TOO_BIG` | The value or length is above the upper limit (such as an `input` over 20,000 characters). |
| `UNKNOWN_FIELD` | A field not in the schema was sent. |
| `ALREADY_EXISTS` | The value must be unique and already exists in another record (ERR-06). |

**Why:** The client can show each error under the matching form field. Because field error codes are fixed, the client chooses the message in its own language.

**Example:**

```json
{
  "title": "Bad Request",
  "status": 400,
  "detail": "2 fields are invalid.",
  "instance": "/v1/jobs",
  "code": "VALIDATION_FAILED",
  "error": "validation_failed",
  "requestId": "4bf92f3577b34da6a3ce929d0e0e4736",
  "errors": [
    { "field": "type", "code": "INVALID_TYPE", "message": "Invalid input: expected string, received number" },
    { "field": "extra", "code": "UNKNOWN_FIELD", "message": "Unrecognized key: \"extra\"" }
  ]
}
```

**Check:** `ZodValidationPipe` converts zod errors to this format.

### ERR-05: Unexpected errors do not show internal details

**Rule:** Any error that is not one of our error classes and that no mapper recognizes is an unexpected error. The response returns status code 500, the `INTERNAL_ERROR` code and a fixed `detail` text: `An unexpected error occurred.` The error's own message is not written to the response. The full error, with its stack trace, is logged at `error` level.

**Why:** Messages of unexpected errors can contain internal information such as database structure, file paths, library details or the parameters of a query. The client can ask for support with `requestId`, and the team sees the full error in the log.

**Check:** The exception filter.

### ERR-06: Prisma errors are translated into meaningful errors

**Rule:** The exception filter translates Prisma errors that leave services uncaught as follows:

| Prisma code | Meaning | Response |
|---|---|---|
| `P2002` | Unique constraint violation | 409, `CONFLICT`. Conflicting fields appear in the `errors` list with the `ALREADY_EXISTS` code. |
| `P2025` | The record to update or delete does not exist | 404, `NOT_FOUND` |
| `P2034` | Transaction conflict or deadlock | 409, `CONFLICT` |
| Others | | 500, `INTERNAL_ERROR` (ERR-05) |

This translation is a safety net. In this project, writes that may conflict are written with raw SQL that resolves the conflict itself: the idempotency key and the job content are inserted with `ON CONFLICT DO NOTHING`, and credits are deducted with a conditional `UPDATE`. Transactions run with `Read Committed`. So in the normal flow, these Prisma errors do not come out of services.

If a service knows the business meaning of the error, it catches the conflict itself and throws it with its own code. For example, if a request arriving with the same key conflicts despite retries, it returns 409 `CONFLICT` with `ConflictError`.

**Why:** A unique constraint violation and a missing record are the result of the client or of concurrency, not a server error. If it is returned as 500, the client cannot know that it should retry, and the team gets alerts for nothing.

**Check:** The exception filter (`PrismaErrorMapper`).

### ERR-07: Error messages are in English

**Rule:** The `detail` and `errors[].message` fields are written in English and are meant for developers. The client chooses the text it shows the user in its own language, by the `code` and `errors[].code` values.

**Why:** When the text shown to the user changes, the API does not need to change. When a new language is added, only the translations in the client are added.

**Check:** Code review.

### ERR-08: The stack trace is turned on with ERROR_INCLUDE_STACK

**Rule:** With `ERROR_INCLUDE_STACK=true`, a `stack` field is added to error responses. The default value is `false`. If this value is set to `true` while `NODE_ENV=production`, the application does not start and environment variable validation fails. Regardless of this setting, the stack trace is always written to the log for 5xx errors (LOG-05).

**Why:** The stack trace makes it easier to see the error from the response during development, but it is not always needed. In production it cannot be turned on, because it exposes the code structure.

**Check:** Environment variable validation (`src/core/config/env.validation.ts`).

## Worker errors

### ERR-09: In the worker, a job's error is not an HTTP error

**Rule:** The worker does not produce an HTTP response. An error that occurs while a job is processed is an outcome written to the job's record:

| Error | What happens | Log |
|---|---|---|
| The provider returned a transient error (`TransientAiError`) or timed out | The job is retried after a wait. If the attempts run out, the job becomes `failed` and its credits are released. | `PROVIDER_CALL_FAILED` (`warn`), then `JOB_RETRY_SCHEDULED` or `JOB_FAILED` (`log`) |
| The provider rejected the input (`PermanentAiError`) | The job becomes `failed` without a retry and its credits are released. | `PROVIDER_CALL_FAILED` (`warn`), then `JOB_FAILED` (`log`) |
| The provider threw an unrecognized error | Treated as a transient error. Retrying is safe and the number of attempts is limited. | `error` (`PROVIDER_ERROR_UNEXPECTED`) |
| Infrastructure error (database unreachable) | The job is not written. The Kafka message is retried after a short wait. | `error` (`JOB_PROCESSING_FAILED`) |

A `failed` job carries a lowercase constant in the `error_code` column (such as `provider_rejected`, `provider_timeout`, `worker_lost`). The values are in the `JobFailureCode` object in `src/modules/job-worker/job-worker.constants.ts`. The client sees this value in the `errorCode` field of the `GET /v1/jobs/:id` response (`API_STANDARDS.md`, API-05). Provider adapters translate the provider's own errors into one of these two classes. The provider's error text is not returned to the client.

**Why:** The client learns the job's outcome later, not at request time. So the error cannot be an HTTP status code; it must be stored in the job's record. Splitting transient and permanent errors decides two things: whether a retry will help, and whether the user's money will be wasted. Retrying a permanent rejection repeats a paid call when the result will not change. An unrecognized error is treated as transient, because trying once too often by mistake is cheaper than dropping the job at once on a transient error. But because this case points to a missing mapping in the adapter, it is logged at `error` level.

The `error_code` value is lowercase, because it is not an HTTP error code but an enumerated value of a job field (API-05).

**Check:** Code review. The behavior is tested with `test/job-processing.e2e-spec.ts`.

## Pending proposals

The items below are not rules yet. If approved, they will be added to the list above with an ID.

- **The `requestId` of the request that created the job is stored in the `jobs` table.** Today the reconciler reads it from the outbox, which loses it after outbox cleanup (LOG-02). Stored on the job, the value of the first request would be kept for the job's whole life.
- **Phone numbers and e-mail addresses are partly masked.** Part of the phone number and the e-mail is hidden (`+90532*******`, `a***@example.com`). The support team can still recognize the record, but the full value does not appear in the logs.
- **The log retention period is set in the log tool.** For example, 30 days. The period will be chosen based on KVKK and internal audit needs.
- **Sentry is added for error notifications.** For 5xx errors, messages that land in the invalid message topic, and `PROVIDER_ERROR_UNEXPECTED`, a notification goes to the team.

## Technical details

This section is for the person who will change the infrastructure.

**Logger:** `src/core/logging/app-logger.ts` extends the `ConsoleLogger` class of NestJS 12. The format (`json`, `colors`) and structured fields (`flattenParams`) are set with `ConsoleLogger`'s own options. Masking is done with `src/core/logging/mask.ts`. NestJS's `redact` option was not used, because it masked only exactly matching field names and missed variations such as `new_password` (found in the 22 October 2026 review). Log messages written as text are not masked, so data is not written into the message (LOG-03). It is used with `app.useLogger()` in `main.ts` and `worker.ts`. Startup lines are held with `bufferLogs` until `AppLogger` is ready, so they are also written in the same format.

**Request and job context:** `src/core/context/request-context.ts` carries `requestId`, and `jobId` in the worker, through the whole operation with Node.js's `AsyncLocalStorage` class. The values do not need to be passed to functions as parameters. The `nestjs-cls` package was not used, because no extra package was needed (SEC-04). In the API, `RequestIdMiddleware` sets up the context; in the worker, `JobProcessorService.process`, `JobReconcilerService`, `JobOutboxRelayService` and `JobIdempotencyCleanupService` do. Outside any context, `RequestContext.logFields` returns the per-process `requestId`. Because the `close` event that runs after the response is sent can fall outside the request context, the listener is bound to the context with `RequestContext.bind`.

**Request logs:** NestJS adds the layer that reads the request body when the application starts. `configureHttp` (`src/core/http/configure-http.ts`) registers the `RequestIdMiddleware` and `HttpLoggingMiddleware.trackResponse` steps before that. This way, requests whose body cannot be read (malformed JSON, 413) also get a `requestId`, and the exit line is written. For these requests the entry line is not written, because the body could not be read. `HttpLoggingMiddleware.use` runs after the body is read and writes the entry line together with the body. `ResponseBodyInterceptor` writes the body of successful responses to the request context, and `ProblemDetailsFilter` writes the body of error responses.

**Prisma query logs:** `PrismaClient` is created with the `log: [{ emit: 'event', level: 'query' }]` option, and the query, parameters and duration are taken with `$on('query')`. This method works with Prisma 7.10.1 and `@prisma/adapter-pg`. Because the query event runs in the context of the operation that started the query, the line carries `requestId`, and `jobId` in the worker. Prisma gives the `params` field as a JSON string.

**Error mappers:** `ProblemDetailsFilter` uses the first matching mapper in the `PROBLEM_MAPPERS` list: `AppErrorMapper`, `HttpExceptionMapper`, `HttpErrorMapper` (`core/errors/mappers`) and `PrismaErrorMapper` (`infra/database`). `HttpErrorMapper` translates errors that Express throws before the request reaches NestJS (such as 413 for a large body). Because these errors are not `HttpException`, they used to return 500 (found in the 22 October 2026 review). The list is set up in `app.module.ts`, so the `core` layer does not import the `infra` layer (ARCH-02). The code of errors NestJS throws itself is derived from the HTTP status text: 405 becomes `METHOD_NOT_ALLOWED`, 415 becomes `UNSUPPORTED_MEDIA_TYPE`. A malformed JSON body is the exception to this and returns `INVALID_JSON`. Because NestJS turns this error into a `BadRequestException` keeping only its message, it is recognized by the word "JSON" in the message. With Prisma 7 driver adapters, the conflicting fields of a `P2002` error are at the path `meta.driverAdapterError.cause.constraint.fields`. The `meta.target` field from older Prisma versions is not filled. This path was verified from Prisma's source code and the `@prisma/driver-adapter-utils` types. The translation is exercised with a unit test (`prisma-error.mapper.spec.ts`). Because uniqueness conflicts in the project are resolved with `ON CONFLICT`, there is no database test that produces a real `P2002`.
