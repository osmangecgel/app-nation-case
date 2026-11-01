# Security Standards

This document defines the security rules of this project that are not tied to a specific feature: dependencies, secrets, data leaks in responses and logs, request size, internal endpoints and the container. Each rule has an ID (such as `SEC-01`). Use this ID to refer to a rule in code review.

Authentication is out of scope for this project. The caller is identified by the `X-User-Id` header, and a user sees only their own jobs (`API_STANDARDS.md`, API-10). Rules for sign-up, login and authorization will be added when these features are built (see "Topics to address when the feature is built").

To change a rule, open a PR that changes this file and write the reason in the PR description.

> **Status (31 October 2026):** The project has no CI, Dependabot or gitleaks. `npm audit --omit=dev` reports 0 vulnerabilities. On 31 October 2026 `npm audit fix` updated `body-parser` to 2.4.0 (GHSA-27r3-jxmh-p828), `multer` to 2.5.0 (GHSA-q7qp-rjg7-q26m) and `@nestjs/platform-express` to 12.3.2. These are the same major versions, and only `package-lock.json` changed (SEC-01).

## Rule summary

| ID | Rule |
|---|---|
| SEC-01 | If production packages have a high or critical vulnerability, it is fixed before delivery, or its impact is assessed and recorded. |
| SEC-02 | `package-lock.json` is kept in the repo. The Docker image installs packages with `npm ci`. |
| SEC-03 | Removed: the repo is not connected to a GitHub repository or CI, so Dependabot cannot run. Package updates are done with the SEC-01 check. |
| SEC-04 | Before a new package is added, the checklist is filled in and the user's approval is obtained. |
| SEC-05 | Secrets are not written in the code or the repo. They are given only through environment variables. |
| SEC-06 | Endpoint responses are always built with a response DTO. A Prisma record is not returned directly. |
| SEC-07 | The job's text and result are not written to logs, queue messages, lists or the CSV file. The only exception is development query logs (LOG-08). |
| SEC-08 | A request body can be at most 256 KB. A larger body is rejected with 413 without being read. |
| SEC-09 | Internal endpoints are under `/internal` and require no identity. In production they must be reachable only from the internal network. |
| SEC-10 | The application runs inside the container as a non-root user. |

## Dependencies

### SEC-01: No delivery with a vulnerable package

**Rule:** Before delivery, `npm audit --omit=dev --audit-level=high` is run. If packages that go to production have a high or critical vulnerability:

- If a fix exists, the package is updated and the tests are run again.
- If no fix exists, or the update breaks something else, it is assessed whether the vulnerability affects the application. The package, the vulnerability ID and the assessment are written in the "Status" line of this file. When a fix is released, the line is updated.

Vulnerabilities in development packages, and low and moderate vulnerabilities, do not block delivery.

**Why:** Vulnerabilities in production packages directly affect the running application. Development packages do not enter the production image (the Dockerfile runs `npm prune --omit=dev`). Not every vulnerability carries the same risk: a vulnerability in an unused code path (`multer`, when there is no file upload) is different from one in code that runs on every request (`body-parser`). Writing down the assessment keeps the decision from being forgotten and saves the next person from repeating the same review.

**Check:** Manually, before delivery. If CI is set up, this command is added to CI.

### SEC-02: The lockfile is kept in the repo

**Rule:** `package-lock.json` is always kept in the repo. The Dockerfile installs packages with `npm ci`, not `npm install`. `npm ci` installs exactly the versions in the lockfile. It fails if the lockfile does not match `package.json`. The Node.js version is pinned with `.nvmrc`, `engines` and `engine-strict=true` (`.npmrc`).

**Why:** Every environment runs with the same package versions. A new, malicious version of a package cannot enter the project without the lockfile being updated. A "works on my machine" difference cannot come from a package version.

**Check:** Dockerfile.

### SEC-04: Checklist for a new package

**Rule:** Before a new package is added to the project, the questions below are answered and the answers are written in the PR description. Before adding a package, Claude presents this list to the user and asks for approval.

| Question | Acceptance criterion |
|---|---|
| Does the project already have a package that does the same job? | If so, the new package is not added (`CODING_STANDARDS.md`, CODE-15). |
| Can the same job be done in a few lines with Node.js or an existing package? | If so, the package is not added. Example: for converting zod to OpenAPI, zod 4's `toJSONSchema` function was used instead of an extra package. |
| Is the package still maintained? | A new version must have been released in the last 12 months. |
| Is the license suitable? | A license that allows commercial use, such as MIT, Apache 2.0, BSD or ISC. |
| How widely is it used? | The weekly download count and the number of projects that use it are written down. |
| Does it have a known vulnerability? | After adding the package, `npm audit` must not show a new high or critical vulnerability. |
| Does it go to production? | If it is used only in development, it is added under `devDependencies`. |

**Why:** Every package enters the project with its own dependencies and grows the attack surface. A vulnerability in an unmaintained package may never be fixed. A package added for a few lines of work brings far more code than those few lines into production.

**Check:** Code review. A PR that changes `package.json` contains this list.

## Secrets

### SEC-05: Secrets are not written in the code or the repo

**Rule:**

- Secrets such as passwords, API keys, tokens and connection URLs are given only through environment variables and are read with `ConfigService` (`CODING_STANDARDS.md`, CODE-14). On startup, all variables are validated with zod (`src/core/config/env.validation.ts`). If a value is missing or invalid, the application does not start. CODE-14 allows two exceptions: command-line scripts that run outside Nest (the seed) read their variables with `loadScriptEnv()` (`src/core/config/script-env.ts`, also validated with zod), and the tool config file `prisma.config.ts` reads `DATABASE_URL` from `process.env`.
- The `.env` file does not enter the repo or the Docker image. `.gitignore` and `.dockerignore` ensure this.
- The `.env.example` file contains only sample values that work in local development (such as the `postgres` password). A value from a real environment is not written to this file.

If a secret was committed by mistake, deleting the commit is not enough. The secret stays in the git history and with everyone who cloned the repo. That password or key is changed (rotated) at once, and then the commit is cleaned up.

**Why:** A key that enters the repo reaches everyone who has access to the repo. If the repo is later shared or leaked, the key leaks too. The Docker image is also a file that gets distributed, so `.env` does not enter the image either. Validating the variables on startup makes a missing setting show up at deploy time, not on the first request.

**Check:** Code review. There is no automatic pre-commit scan (gitleaks); see the "Pending proposals" section.

## Responses and data

### SEC-06: Responses are always built with a response DTO

**Rule:** An endpoint does not return the record Prisma returns directly. The service converts the record to a response DTO that explicitly picks the fields to return. The conversion function lives in the module's `dto/` folder, next to the DTO (`toJobDto`, `toJobListItemDto`, `toUserCreditsDto`, `toHealthDto`). The query also reads only the needed columns (`select`, for example `JOB_LIST_SELECT`).

**Why:** A Prisma record contains every column in the table. The `jobs` table has internal columns such as `lock_token`, `job_provider_code`, `model_version` and `attempt_count`. An endpoint that returns the record directly exposes these, and every column added to the table later. TypeScript does not prevent this: even if the return type is `JobDto`, an object with extra fields fits this type and gives no compile error. So a new object is built by picking the fields one by one. `select` ensures that unneeded columns, especially long texts, are never read from the database.

**Example:**

```ts
// dto/user-credits.dto.ts
export function toUserCreditsDto(row: { id: string; balance: number; reserved: number }): UserCreditsDto {
  return { userId: row.id, balance: row.balance, reserved: row.reserved };
}

// users.service.ts
// Wrong: returns every column of the users table (such as active_job_count)
async getCredits(userId: string): Promise<UserCreditsDto> {
  return this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
}

// Correct
async getCredits(userId: string): Promise<UserCreditsDto> {
  const user = await this.prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, balance: true, reserved: true },
  });
  return toUserCreditsDto(user ?? { id: userId, balance: 0, reserved: 0 });
}
```

**Check:** Code review. The service's public methods return a DTO, not a Prisma record.

### SEC-07: The job's text and result do not leak

**Rule:** The job's text (`input`) and result (`result`) are the user's content. They exist only where needed:

| Place | Text and result |
|---|---|
| Database (`job_contents`) | Present. This is the single source. |
| `GET /v1/jobs/{id}` | Result present, only if the job is `completed`. The text is not returned. |
| `GET /v1/jobs` and the CSV file | Absent (`JOB_LIST_SELECT` does not read these columns). |
| Kafka message | Absent. The message carries only `job_id` (`QUEUE_STANDARDS.md`, QUEUE-06). |
| Logs | Absent, with one exception (below). Fields named `input` and `result` are always masked. Request and response bodies are not logged at all by default (`LOG_HTTP_BODIES=false`). |
| Cache Redis | Result present, keyed by a content hash and with a TTL. The key has no user ID. |

**Exception:** With `NODE_ENV=development` and `LOG_DB_QUERIES=true`, database query logs include the query parameters, and these include the job's text (`ERROR_AND_LOGGING_STANDARDS.md`, LOG-08). The parameters arrive as a single string, so they cannot be masked field by field. `LOG_DB_QUERIES` is off by default, `docker-compose.yml` forces it off for the app and the worker, and parameters are never logged outside development.

**Why:** User text can contain personal data, trade secrets or passwords. Logs are a place that far more people and tools (log collection and search tools) can access than the database, and they are usually kept longer. Keeping a field out of the logs cannot be left to the care of each person who writes a log line, so masking is automatic, by field name (`ERROR_AND_LOGGING_STANDARDS.md`, LOG-07). Carrying the text in a Kafka message copies it to the broker's disk and to every system that can read the message. The worker reads the text from the database itself. Keeping the result in the cache is a deliberate choice: it is how the provider is not called again (and not paid again) for the same content. The key is a content hash, so the cache does not reveal who sent which text.

**Check:** Code review. The masking list is in `src/core/logging/logging.constants.ts` and is tested by `mask.spec.ts`.

### SEC-08: Request body limit

**Rule:** A JSON request body can be at most 256 KB (`src/core/http/configure-http.ts`). A larger body is rejected without being read and returns 413 `PAYLOAD_TOO_LARGE`. The documentation of every endpoint with a body includes 413 automatically (`API_DOCUMENTATION_STANDARDS.md`, DOC-04).

The limit is chosen based on the size of the largest valid request. Today the largest request is `POST /v1/jobs` with a 20,000-character `input`. In raw UTF-8 this is at most ~80 KB. But some clients write every non-ASCII character escaped (the default of Python's `json.dumps`): a letter as `\uXXXX` (6 bytes), and a character outside the Basic Multilingual Plane, such as an emoji, as a surrogate pair `\uXXXX\uXXXX` (12 bytes). The request is then up to ~240 KB. Express's default 100 KB limit, and later a 128 KB limit sized for letters only, rejected such valid requests with 413; tests caught both (`test/jobs.e2e-spec.ts`). If the `input` limit changes, this limit is recalculated.

**Why:** Without a limit, a single client can fill the server's memory by sending a very large body. Rejecting the body without reading it means this memory is never allocated. The limit only needs to be a bit larger than the largest valid request: a larger limit serves no legitimate request and only grows the attack surface.

**Check:** Endpoint test (`test/errors.e2e-spec.ts`).

### SEC-09: Internal endpoints

**Rule:** Endpoints called only by internal systems (such as a payment system) start with the `/internal` prefix and do not require `X-User-Id`: `POST` and `GET /internal/users/{id}/credits`. These endpoints can add balance to a user, so in production they must be reachable only from the internal network. This constraint is not enforced in the application but in the gateway or load balancer in front of it, by closing the `/internal` path to the outside.

In this repo the internal endpoints are open. The case allows credit grants to be done this way, and authentication is out of scope.

**Why:** Granting credit is the most valuable operation in the system: anyone who can reach this endpoint can get unlimited credit. Service-to-service authentication (mTLS or signed tokens) is out of scope for this project. A network constraint gives the same protection without code in the application. A shared prefix lets this constraint be written as a single path rule, and a new internal endpoint falls under the rule automatically. The endpoint being visible in the documentation is not a vulnerability (`API_DOCUMENTATION_STANDARDS.md`, DOC-05).

**Check:** Code review: a new internal endpoint is written under `/internal`. In the production setup, the network rule is checked.

## Runtime environment

### SEC-10: The container runs as a non-root user

**Rule:** The Docker image runs the application as the `node` user from the Node.js image (`USER node`). The production image contains `package.json`, the compiled code (`dist`), the production packages and the Prisma files: the `prisma` folder (schema, migrations and the generated client, including its TypeScript sources) and `prisma.config.ts`, which the `migrate` service needs. The application's source code (`src`), tests and development packages do not enter the image. The `Dockerfile`'s `test` stage, which does contain them, is built only for the compose `test` service (`docker compose run --rm test`), runs as `node` too, and is never the image that is deployed: the production stage is the last one, so a plain `docker build` produces it. The `verify` stage (`node:24.22.2-alpine` with the Docker CLI, Compose and curl; entry point `scripts/verify.sh`) is built only for the compose `verify` service (`docker compose run --rm verify all`). That service mounts the Docker socket, which gives it control of the host's Docker, so it is a local tool only and is never deployed.

The one directory the application writes to is `/data/exports`, the volume where background exports keep their files (`EXPORT_FILES_DIR`). The image creates it owned by `node`, so a new volume starts with that owner and the application needs no other write access. Files are named only by the export's id; the store refuses any other key, so a key can never point outside the directory.

**Why:** If a vulnerability in the application allows code execution, the attacker runs with the permissions of the application's user. The root user can change every file inside the container and makes it easier to exploit container escape vulnerabilities. The application does not need root permissions (port 13400 is greater than 1024). Every extra file and package in the image is a tool the attacker can use.

**Check:** Dockerfile.

## Security rules in other standards

The following security rules are defined in the related standards files. They are only listed here.

| Topic | Rule |
|---|---|
| Another user's record | `API_STANDARDS.md`, API-10: a `user_id` condition in every query, 404 for another user's job |
| Spending credit twice | `API_STANDARDS.md`, API-11: `Idempotency-Key` |
| Request and resource usage limits | `API_STANDARDS.md`, API-09 (requests per IP) and API-13 (jobs per user) |
| CSV injection | `API_STANDARDS.md`, API-12: `'` is added to values that start like a formula |
| SQL injection | `DATABASE_STANDARDS.md`, DB-12: raw SQL only with `$queryRaw` and `$executeRaw`, parameterized |
| Validation of incoming data | `CODING_STANDARDS.md`, CODE-11: validation with zod, unknown fields are rejected |
| Environment variables | `CODING_STANDARDS.md`, CODE-14: read only with `ConfigService` |
| Sensitive data in logs | `ERROR_AND_LOGGING_STANDARDS.md`, LOG-07: masking |
| Internal details in error responses | `ERROR_AND_LOGGING_STANDARDS.md`, ERR-05 and ERR-08: a fixed message for 500, `ERROR_INCLUDE_STACK` cannot be enabled in production |
| Sensitive data in cache and messages | `CACHE_STANDARDS.md`, CACHE-08 and `QUEUE_STANDARDS.md`, QUEUE-06 |

## Topics to address when the feature is built

These topics depend on the authentication and authorization features. Their decisions will be made and added to this document when the related feature is built.

- Authentication: the token structure that will replace the `X-User-Id` header. Only `UserIdGuard` changes (API-10).
- Service-to-service authentication: protecting the internal endpoints with signed requests, in addition to the network constraint (SEC-09).
- Role model and admin endpoints.
- Audit log: credit movements are already kept in the `user_credit_ledger` table. Who made a grant will be added once the caller of the internal endpoints is identified.

## Pending proposals

The items below are not rules yet. If approved, they will be added to the list above with an ID.

- **Secret scanning.** gitleaks runs before each commit (with husky) and in CI. gitleaks is not an npm package; it is a separate program. The project has no git repository or CI yet.
- **Automatic package updates.** If the repo moves to GitHub, Dependabot opens PRs once a week for npm and Docker updates.
- **HTTP security headers and CORS.** Today there is no helmet and CORS is not enabled. Since there is no CORS header, browsers cannot call the API from another origin. If a browser-based client is added, CORS is opened only to the origins in the `CORS_ORIGINS` environment variable and security headers are added with helmet.
- **Security scanning of source code and image.** Code is scanned with CodeQL or Semgrep, and the Docker image with Trivy. To be set up together with CI.
