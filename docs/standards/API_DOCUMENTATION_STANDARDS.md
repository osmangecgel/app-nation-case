# API Documentation Standards

This document defines how this project's HTTP endpoints are documented with OpenAPI. Each rule has an ID (such as `DOC-01`). Use this ID to refer to a rule in code review.

Endpoint design follows `API_STANDARDS.md`, and error responses follow `ERROR_AND_LOGGING_STANDARDS.md`. This document defines how those rules are explained to clients.

To change a rule, open a PR that changes this file and write the reason in the PR description.

> **Status (30 October 2026):** Applied to the project. `/docs`, `/docs/openapi.json`, `@ApiEndpoint`, `npm run docs:generate` and `npm run docs:check` work. Documented endpoints: `jobs` (4), `internal` (2) and `health` (1). There is no automatic check for breaking changes; it is done in code review (DOC-06).

## Rule summary

| ID | Rule |
|---|---|
| DOC-01 | Every endpoint is documented with `@ApiEndpoint`: summary, tag, operation ID, request, headers and response. |
| DOC-02 | Body, query and path parameters are documented from the zod schemas used for validation. Schemas are not rewritten for documentation. |
| DOC-03 | Every field that carries information its name and type do not convey has a description, and every request field has an example. |
| DOC-04 | Every error status code and error code an endpoint can return is documented. |
| DOC-05 | The document is served with Swagger UI at `/docs` in every environment. Internal endpoints appear separately under the `internal` tag. An endpoint's security does not depend on the document. |
| DOC-06 | `openapi.json` is stored in the repo. `npm run docs:check` checks that the file is up to date and that every endpoint is documented. |
| DOC-07 | Description texts in the document are in English. |

## Content

### DOC-01: Every endpoint is documented

**Rule:** Every endpoint is documented with the `@ApiEndpoint` decorator (`src/core/http/openapi/api-endpoint.decorator.ts`). The decorator and the controller contain:

| Item | Rule | Example |
|---|---|---|
| Summary (`summary`) | A short sentence that starts with a verb and has no period | `Start a job` |
| Description (`description`) | Only if the summary is not enough. Explains the business rule and side effects. | `Reserves the job cost from the balance and queues the job.` |
| Tag (`tag`) | The module name. `internal` for internal endpoints (DOC-05). Written once on the controller class with `@ApiTags`. | `@ApiTags('jobs')` |
| Operation ID (`operationId`) | `<controller>.<method name>`, generated automatically. Unique across the whole API. | `jobs.create` |
| Request | The zod schemas of the body, query and path parameters (DOC-02) | `body: CreateJobSchema` |
| Headers | Headers the client must send, with `@ApiHeader`. On the controller if valid for all endpoints, on the method if for a single endpoint. | `X-User-Id`, `Idempotency-Key` |
| Response | Success status code and response schema | `202`, `JobCreatedSchema` |

**Why:** Tools that generate client code from OpenAPI use the operation ID as the function name. If the ID changes, client code breaks, so it is not written by hand; it is generated from the controller and method names. Tags group endpoints in Swagger UI. If required headers are not in the document, the client gets a 400 or 401 on the first try and has to read the source code to find out why.

**Example:**

```ts
@Get(':id')
@ApiEndpoint({
  summary: 'Get a job',
  description: 'Status, result when completed and error code when failed. Another user’s job is reported as not found.',
  params: JobIdParamsSchema,
  paramsTakeAnyValue: true,
  response: { status: HttpStatus.OK, schema: JobSchema },
  errors: [UNAUTHORIZED, { status: HttpStatus.NOT_FOUND, code: JobErrorCode.JOB_NOT_FOUND }],
})
get(@UserId() userId: string, @Param(new ZodValidationPipe(JobIdParamsSchema)) params: JobIdParams): Promise<JobDto> {
  return this.jobs.get(userId, params.id);
}
```

If an endpoint has more than one success response (such as 200 and 503 for `/health`), `response` is given as a list. Responses whose body is not JSON (`GET /v1/jobs/export.csv`) are written without a schema, and the content type is set with `@ApiProduces('text/csv')`. Endpoints excluded from the rate limit are marked with `rateLimited: false`. This option both removes the 429 response from the document and turns off the rate limit, so the document and the behavior do not drift apart (`API_STANDARDS.md`, API-09). An endpoint whose service answers a malformed path parameter with 404, as it does for a missing record, is marked with `paramsTakeAnyValue: true`. The path parameters then add no 400 `VALIDATION_FAILED` response to the document (DOC-04). `GET /v1/jobs/{id}` uses it: a malformed id is reported like another user's job, so nothing reveals which ids exist.

**Check:** `npm run docs:check` fails and lists the endpoints if any endpoint has no `@ApiEndpoint`. While the application runs, the same case is logged as an `UNDOCUMENTED_ENDPOINTS` warning.

### DOC-02: The document is generated from zod schemas

**Rule:** Body, query and path parameter schemas are written only once, with zod (`CODING_STANDARDS.md`, CODE-11). `@ApiEndpoint` converts these schemas to OpenAPI format itself. No separate DTO class, `@ApiProperty` decorator or hand-written JSON schema is used for documentation.

- Requests are documented as the client sends them (`io: 'input'`), and responses as the client receives them. For example, `limit` appears with its default value, and `cursor` appears in its text form before decoding.
- Every request body and response schema, and every schema nested in them that has its own name, is named with `.meta({ id })` (`CreateJob`, `Job`, `JobPage`, `Pagination`, `ProblemDetails`), even if a single endpoint uses it. These schemas appear once in OpenAPI as components (`components.schemas`), and a schema shared by several endpoints is not repeated. Path and query parameter schemas are not named: they are expanded into separate parameters.
- Request headers are documented with `@ApiHeader`, not from a zod schema, because `@ApiEndpoint` does not take a header schema. The header is validated in its own place (`UserIdGuard`, `@IdempotencyKey()`). If a header's limit changes, the `@ApiHeader` description is updated too.

**Why:** When validation and documentation are generated from the same schema, they cannot drift apart. When a field is added or removed, the document updates itself. Documentation written separately contradicts the code over time and misleads the client. Headers are the only exception to this rule. Today there are two headers, and only a few lines of their descriptions are repeated, so adding header support to the decorator is not yet worth the extra complexity.

**Check:** Code review.

### DOC-03: Field descriptions and examples

**Rule:**

- A field's description gives the information its name and type do not convey: unit, limit, when it is `null`, business meaning. If the name and type are enough (`createdAt`, `date-time`), no description is written.
- Every field that can be `null` says when it is `null`.
- Every request field has a realistic example, because "Try it out" in Swagger UI builds a ready request body from these examples. For response fields, an example is written if the automatically generated value (UUID, date) would be misleading.
- Example values follow the API formats (`API_STANDARDS.md`, API-05).
- Descriptions are written inside the schema with `.meta({ description })` or `.describe()`, and examples with `.meta({ example })`.
- Examples do not use real personal data or real user IDs (values like `user-1` are used).

**Why:** An undescribed limit or `null` meaning forces the client developer to read the source code or guess. Writing a description for every field, on the other hand, produces texts that carry no information, such as `jobId: "Job id."`, and makes the reader miss the descriptions that really matter.

**Example:**

```ts
export const UserCreditsSchema = z
  .object({
    userId: UserIdSchema,
    balance: z.number().int().meta({ description: 'Credits that can be spent now.', example: 7 }),
    reserved: z
      .number()
      .int()
      .meta({ description: 'Credits held by unfinished jobs; captured or released when they finish.', example: 3 }),
  })
  .meta({ id: 'UserCredits' });
```

**Check:** Code review.

### DOC-04: Error responses are documented

**Rule:** Every error an endpoint can return is written in the `errors` list inside `@ApiEndpoint`, with its status code and error code (ERR-02). This list also covers the errors thrown by the service and the guard: 401 `USER_ID_REQUIRED` for `X-User-Id`, and 402, 404, 422 and 429 for business rules. All error responses are shown with the shared `ProblemDetails` schema (ERR-01). Error codes with the same status code are listed in a single response, in its description.

Errors that apply to every endpoint are added automatically by the decorator and are not written by hand:

| Status | Code | When it is added |
|---|---|---|
| 400 | `VALIDATION_FAILED` | If the endpoint has a body, a query parameter, or a path parameter not marked with `paramsTakeAnyValue: true` (DOC-01) |
| 400 | `INVALID_JSON` | If the endpoint has a body |
| 413 | `PAYLOAD_TOO_LARGE` | If the endpoint has a body |
| 429 | `TOO_MANY_REQUESTS` | If the endpoint is not marked with `rateLimited: false` (API-09) |
| 500 | `INTERNAL_ERROR` | On every endpoint |

For a streamed response (`API_STANDARDS.md`, API-12), only errors before the stream starts are documented. An error after the stream starts is reported by closing the connection and has no body.

**Why:** The client chooses the text to show the user based on the error code (ERR-07). 429 has two meanings: `TOO_MANY_REQUESTS` means "wait a little", `TOO_MANY_ACTIVE_JOBS` means "wait for jobs to finish". A client that does not know which codes can arrive cannot tell them apart and shows every error the same way. Automatic errors collect in one place the lines that are the same on every endpoint and easy to forget.

**Check:** Code review. An error code thrown in the service must also be in the endpoint's `errors` list. Automatic errors are tested with `test/openapi.e2e-spec.ts`.

## Publishing

### DOC-05: The document is open in every environment

**Rule:** Swagger UI is served at `/docs` and the OpenAPI file at `/docs/openapi.json`. The document is open in every environment. These paths are unversioned (API-06).

- Internal endpoints (`/internal/...`) are not removed from the document. They appear in a separate group with `@ApiTags('internal')`, and their descriptions say they are for internal use.
- An endpoint's security relies on the network restriction (SEC-09) and the identity check, not on being hidden from the document.
- Examples and descriptions in the document do not contain server addresses, internal system names or secrets.

**Why:** Client developers can see the current document of the running API directly. The document is generated from code, so every endpoint in it really exists. Hiding internal endpoints from the document does not protect them: someone who knows the address can still call them. In this project an internal endpoint is the only way to load credits, so it must appear in the document for a person trying the API to be able to start a job. When internal endpoints are closed at the network level in production, their presence in the document only says that they exist. This information gives an attacker no access.

**Check:** Code review. `setupApiDocs` is called without checking the environment (`src/core/http/configure-http.ts`). That `/docs` opens is tested with `test/openapi.e2e-spec.ts`.

### DOC-06: openapi.json is stored in the repo and checked

**Rule:**

- The `npm run docs:generate` command generates the `docs/api/openapi.json` file. This file is committed to the repo.
- Every change that changes the API also includes the updated `openapi.json` file. The reviewer sees the API change from this file's diff and checks whether it is a breaking change using the API-06 table in `API_STANDARDS.md`. A breaking change is made with a new API version.
- `npm run docs:check` regenerates the file. It fails if the result differs from the file in the repo or if any endpoint has no `@ApiEndpoint`. This command is run before delivery (`CLAUDE.md`, working process step 4).

**Why:** API changes can be missed in a code diff. The OpenAPI diff shows only the change the client sees. Having the file in the repo lets client teams read the document without running the application. Generation sets up the application in NestJS's `preview` mode, so no database or Redis is needed and the command gives the same result on every machine.

**Check:** `npm run docs:check`.

### DOC-07: Description texts are in English

**Rule:** Summaries, descriptions and field descriptions are written in English. Example values that represent user content (such as job text and result) may be in another language: the `CreateJobSchema` example uses the text `Merhaba dünya`.

**Why:** Descriptions are written next to the code, in the zod schema. Code names and comments (`CODING_STANDARDS.md`, CODE-04) and error messages (ERR-07) are also in English. External teams can read the document without extra translation. Job text, on the other hand, is the user's data. An example with Turkish characters also shows that the API accepts non-ASCII text.

**Check:** Code review.

## Pending proposals

The items below are not rules yet. If approved, they will be added to the list above with an ID.

- **Automatic check for breaking changes.** `openapi.json` is compared with the version on the main branch using a tool like `oasdiff`, and a breaking change is stopped in CI. The project has no CI yet.
- **Authentication scheme.** When authentication is added, a security scheme is defined in the document, and requests can be sent from Swagger UI with a token. Today `X-User-Id` is documented as an `@ApiHeader`.
- **Client code generation.** Type-safe code for clients is generated from the `openapi.json` file.

## Technical details

This section is for the person who will change the documentation infrastructure.

**Package:** `@nestjs/swagger` 12.0.3 (MIT). Added with user approval (SEC-04). It bundles Swagger UI with `swagger-ui-dist`; no extra package was needed.

**zod to OpenAPI:** zod 4 converts schemas to OpenAPI format itself with `z.toJSONSchema(schema, { target: 'openapi-3.0', io })`. No extra package is needed (`src/core/http/openapi/zod-openapi.ts`). Descriptions, examples, limits like `min` and `max`, `enum` values, required fields and `additionalProperties: false` for `strictObject` appear in the output.

**`@ApiEndpoint`:** Converts zod schemas and passes them to the `@nestjs/swagger` decorators (`ApiOperation`, `ApiBody`, `ApiParam`, `ApiQuery`, `ApiResponse`). Adds the automatic errors in DOC-04. With `rateLimited: false` it also applies `@SkipThrottle()`.

**Shared schemas:** zod puts schemas named with `.meta({ id })` under `definitions`. `zod-openapi.ts` moves them under `components/schemas` and fixes the references accordingly. The error body becomes a shared schema named `ProblemDetails` (`src/core/errors/problem-details.schema.ts`).

**Operation ID:** The `Controller` suffix is dropped from the controller class name and the first letter is lowercased: `jobs.create` for `JobsController.create`, `users.grant` for `UsersController.grant`. Even if the tag is `internal`, the operation ID comes from the controller name.

**Undocumented endpoint:** `@ApiEndpoint` adds the `x-api-endpoint` marker to the operation. `createOpenApiDocument` lists operations without the marker and removes the marker from the final document.

**Document generation:** `src/generate-openapi.ts` sets up the application in NestJS's `preview` mode. This mode does not run providers, so it does not connect to the database or Redis. Environment variable validation still runs, so the `.env.example` values are enough.
