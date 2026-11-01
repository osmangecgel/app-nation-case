# Cache Standards

This document defines the rules to follow when using Redis as a cache. Each rule has an ID (such as `CACHE-01`). Use this ID to refer to a rule in code review.

The project has a single Redis, and it is used only as a cache. The queue is in Kafka; its rules are in `QUEUE_STANDARDS.md`.

To change a rule, open a PR that changes this file and write the reason in the PR description.

> **Status (1 November 2026):** The rules are applied in code. The access layer is under `src/infra/cache`: `CacheRedisClient` (connection), `CacheService` (read, write, lock, leased permits), `RedisThrottlerStorage` (rate limit counters) and `CacheHealthIndicator`. Three modules use Redis: `job-worker` reads and writes the cache (`job-result-cache.service.ts`), `jobs` limits streamed exports (`export-admission.service.ts`), and `health` checks the connection (`CacheHealthIndicator`).

## What is kept in Redis

| Domain | Key | Value | TTL | If lost |
|---|---|---|---|---|
| `job_result` | `job_result:<content hash>` | Result text | `job_types.cache_ttl_seconds` (3600 s) | The result is read from `job_contents.result` and written back to Redis. |
| `job_failure` | `job_failure:<content hash>` | Error code (`provider_rejected`) | 300 s | The same input goes to the provider one more time. |
| `job_call_lock` | `job_call_lock:<content hash>` | Token of the lock holder | Provider timeout + 5 s | Two workers can call the provider for the same content. |
| `rate_limit`, `rate_limit_block` | `rate_limit:<throttler>:<key>` | Counter | Rate limit window | The limit loosens for a short time. |
| `export_user` | `export_user:<user id>` | Token of the running streamed export | 30 s, renewed every 10 s | The user can start a second streamed export. |
| `export_slots` | `export_slots:all` (sorted set) | One member per running streamed export, scored by its expiry | 30 s per member, renewed every 10 s | Until the members come back, more than `EXPORT_MAX_CONCURRENT` exports can start. |

No value in this table is needed for correctness. Even if Redis is wiped completely, the system works correctly; it is only slower and more expensive. Most rules follow from this principle.

## Rule summary

| ID | Rule |
|---|---|
| CACHE-01 | Code accesses Redis only through `src/infra/cache`. Modules use `CacheService`. |
| CACHE-02 | The name and TTL of each domain are defined once, in the module that owns the data. A single Redis DB (0) is used; tests use DB 1. |
| CACHE-03 | The key format is `<domain>:<id>`, and `CacheService` builds the key. |
| CACHE-04 | Every key has a TTL. The TTL is given explicitly on every write. Keys without a TTL are not written. |
| CACHE-05 | The database is the source of truth. Redis holds only copies of values that are saved to the database. The result is written to Redis as soon as it is produced, before the settlement transaction saves it; if it is missing from Redis, it is refilled from the database. |
| CACHE-06 | A cached value does not change. Refreshing happens by changing the key. No deletion (invalidation) is written. |
| CACHE-07 | A Redis error does not fail the request or the job. The error is treated as "not in cache" or "no lock". |
| CACHE-08 | Authentication data, personal identity data and user input are not written to the cache. The result key does not reveal the user. |
| CACHE-09 | Application code does not do bulk deletes. `KEYS`, `FLUSHDB` and `FLUSHALL` are used only in tests. |
| CACHE-10 | `CacheService` stores only strings. The module that writes a value decides its format. |
| CACHE-11 | Absence is not cached. Only a permanent rejection by the provider is cached for a short time. |
| CACHE-12 | The cross-worker call lock is taken with `SET NX PX`, and extended and released by comparing the token. The lock only reduces cost; correctness lives in the database. |
| CACHE-13 | Redis is a single instance: 256 MB memory, `allkeys-lfu`, persistence off. |
| CACHE-14 | A limit across instances is a set of leased permits in Redis: taken atomically, renewed, freed by expiry. Without Redis, a smaller per-instance limit applies. |

## Access and configuration

### CACHE-01: Redis is accessed only through src/infra/cache

**Rule:** ioredis and `CacheRedisClient` are used only inside `src/infra/cache`. Modules use the cache through `CacheService`. A module may write a thin wrapper that names the cache for its own purpose (`JobResultCacheService`), but the wrapper also calls `CacheService`. If a Redis-specific command sequence is needed (such as the Lua script of the rate limit counter), that code is also written under `src/infra/cache` (`RedisThrottlerStorage`).

**Why:** The key format (CACHE-03), the mandatory TTL (CACHE-04) and the error behavior (CACHE-07) are applied in one place. A module that accesses Redis directly can skip all three. The most dangerous one is the error behavior: a single `redis.get` call written without `try/catch` fails that request with a 500 during a Redis outage. Also, changing Redis (cluster, another version, another product) means changing a single folder.

**Usage:**

| Method | What it does | If Redis is down |
|---|---|---|
| `get(domain, id)` | Reads the value. Returns `null` if the key does not exist. | `null` |
| `set(domain, id, value, seconds)` | Writes the value with the given TTL. | Does nothing. |
| `acquireLock(domain, id, token, ms)` | Returns `true` if the lock was taken, `false` if someone else holds it. | `null` |
| `releaseLock(domain, id, token)` | Deletes the lock if it is still held by this token. | Does nothing; the lock clears by itself when its TTL expires. |
| `extendLock(domain, id, token, ms)` | Sets the lock to expire `ms` from now if it is still held by this token. Returns `false` if it is not. | `null` |
| `exists(domain, id)` | Does the key exist? | `null` |
| `acquirePermit(domain, id, holder, limit, ms)` | Takes one of at most `limit` permits for `ms` (CACHE-14). `false` if all are held. | `null` |
| `renewPermit(domain, id, holder, ms)` | Restarts the holder's permit for `ms`. `false` if it already expired. | `null` |
| `releasePermit(domain, id, holder)` | Gives the permit back. | Does nothing; the permit expires by itself. |

There are no `delete` or `clear` methods (CACHE-06, CACHE-09).

**Check:** Code review. Under `src`, `ioredis` or `CacheRedisClient` is not imported outside `src/infra/cache`. Tests (`test/support`) may use the client directly to empty the test Redis.

### CACHE-02: Domain name and TTL are defined in the module that owns the data

**Rule:** The name of a cache domain is defined once, as a constant, in the module that uses it (`RESULT_DOMAIN = 'job_result'` in `job-result-cache.service.ts`). The domain name is written in snake_case. The TTL comes from the source below, depending on who makes the decision:

| Who decides the TTL | Source | Example |
|---|---|---|
| A product rule that can vary by job type | Configuration in the database | `job_types.cache_ttl_seconds` |
| A technical decision in the code | The module's constant | `FAILURE_CACHE_TTL_SECONDS = 300` |
| A value derived from another duration | Calculation | Lock TTL = `timeout_ms + CALL_LOCK_MARGIN_MS` |

All domains use Redis DB 0. Key prefixes separate the domains from each other.

**Exception:** E2e and database tests use DB index 1 on the same instance (`test/support/test-env.ts`), so flushing the test Redis does not touch development data (`TESTING_STANDARDS.md`).

**Why:** A single central "cache config" file requires touching two places for each domain, and it does not help anyway for domains whose TTL comes from the database (the result TTL is set per job type). Keeping the domain name next to its owner also shows who reads and writes that domain.

Separation by DB index is not used, because it brings no benefit: the memory limit (`maxmemory`) and eviction apply to the whole instance, and a DB index does not protect one domain from another. Redis Cluster supports only DB 0. Separation by prefix works in both cases.

**Check:** Code review. The same domain name is not defined in two modules.

### CACHE-03: Key format is domain:id

**Rule:** A cache key has the format `<domain>:<id>`. `CacheService` joins the key; the calling code passes the domain name and the id separately. If the id has more than one part, the parts are separated by a colon (`:`). In result domains, the id is the hex form of the content hash (`src/shared/job-content.ts`, `contentHash`). Rate limit keys are built with the same format inside `RedisThrottlerStorage`: `rate_limit:<throttler name>:<key>`.

**Why:** All keys have the same format. A command such as `redis-cli --scan --pattern 'job_result:*'` can count the keys of a domain, and memory usage can be examined per domain. Because the id is the content hash, all jobs with the same content (including those of different users) share the same key. This is the purpose of the cache: not paying the provider a second time for the same input.

**Example:**

```ts
await this.cache.get(RESULT_DOMAIN, content.messageKey);
// Key: job_result:9f2c...e1 (64 hex characters)
```

**Check:** Code review.

### CACHE-04: Every key has a TTL

**Rule:** Every write method of `CacheService` takes the TTL as a required parameter: `set` in seconds (`EX`), `acquireLock` and `extendLock` in milliseconds (`PX`). There is no way to write without a TTL. The TTL is given explicitly on every call; there is no hidden default.

**Why:** When memory fills up, eviction (CACHE-13) deletes keys anyway. So the TTL is not needed for memory, but for two other reasons:

- **Validity limit of the value.** A permanent rejection is forgotten after 5 minutes; if the provider's rule changed, the input is tried again. A result drops out of Redis after an hour, and memory is left for frequently requested results.
- **Lifetime of the lock.** If the worker holding the lock crashes, no one is left to release it. Without a TTL, the provider could never be called again for that content.

Making the TTL required on the call makes it impossible to skip the question "how long is this value valid?" when adding a new domain.

**Check:** The signature of `CacheService`. No write method without a TTL is added.

## Reading and writing

### CACHE-05: The database is the source of truth

**Rule:** Redis holds only a fast copy of a value that is saved to the database. The permanent rejection (CACHE-11), the lock (CACHE-12) and the rate limit counter are exceptions to this rule, because they are not a copy of a record but short-lived state.

The flow for a result is (`JobResolverService.findKnownOutcome`):

1. Redis is checked first (`job_result`).
2. If it is not in Redis, `job_contents.result` is read. If it exists, it is written back to Redis with the `cache_ttl_seconds` TTL.
3. If it is in neither, the provider is called. The returned result is written to Redis right after the call (`JobResolverService.remember`), before the settlement transaction. Settlement then saves it to `job_contents.result` in the same transaction as the job's result (`JobSettlementService.complete`, first write wins). Settlement saves the result whatever its source, including a result found only in Redis (from a worker that died before its settlement committed). So a job is never completed without a stored result.

The result stays in the database after its TTL expires. The result the user sees is always read from the database (`GET /v1/jobs/:id`), not from Redis.

**Why:** Redis is not persistent (CACHE-13) and deletes keys when memory fills up. If the result were only in Redis, an eviction or a restart would lose a paid-for result, and the result of a completed job would later look empty. When the database is the source of truth, losing Redis only slows down a read.

The result is written as soon as it is produced, because other jobs waiting for the same content (on other workers) check Redis at that moment (CACHE-12). This write is safe, because the result never changes again (CACHE-06). For a value that can change, writing to the cache at the same time as the database write could leave the old value when two writes race.

**Check:** Code review. `test/job-processing.e2e-spec.ts`: when Redis loses the result, the saved result is used and written back to Redis; after the TTL expires, the same result is still returned.

### CACHE-06: A cached value does not change; refreshing happens through the key

**Rule:** Only a value that will never change again is written to Redis. If a result needs to be "refreshed", the value is not updated; the key changes. The content hash in the result key is built from these parts: job type, prompt version, provider, model version and normalized input. When one of them changes, the hash and therefore the key change. The old key is deleted by itself when its TTL expires. This is why `CacheService` has no `delete` method.

`job_contents.result` is also written once and does not change (`saveResult`, with the `result IS NULL` condition).

**Why:** The hardest task in caching is never forgetting to delete the old value when a record changes. If the delete is forgotten, done before the transaction, or Redis is down at that moment (CACHE-07), the old value is returned until the TTL expires. With an unchanging value this problem never occurs: there is no old value to delete, only a key that is no longer asked for.

Changing the prompt or the model is a deliberate "produce a new result" decision. Binding this decision to the key guarantees that the old answer is never returned for the new setup. The provider is also in the key, because two providers can offer different models under the same name.

**Example:** When a prompt that produces bad results is fixed, `job_types.prompt_version` is raised from `v1` to `v2`. New jobs fall on the new key; `v1` results are returned to new jobs neither from Redis nor from the database.

**Note:** If a need arises to cache a record that can change (for example a user's balance), this rule is not enough. In that case, the cache is not added until the deletion rule and its order (delete after the transaction) are written into this document.

**Check:** Code review. For every value written to Redis, the question "can this value change?" is asked.

### CACHE-07: A Redis error does not fail the request or the job

**Rule:** If any command sent to Redis fails, the operation continues as if Redis did not exist:

| Usage | While Redis is down |
|---|---|
| Reading results and rejections | Treated as "not in cache". The result is read from the database or the provider is called. |
| Writing results and rejections | Skipped. |
| Call lock | Returns "no lock" (`null`). The worker continues without a lock (CACHE-12). |
| Rate limit | The request is accepted. |
| `/health` | Returns 200 and `status: degraded`. 503 is returned only if the database is down. |

The connection is set up to fail fast (`cache-redis.client.ts`):

- `enableOfflineQueue: false`: While there is no connection, commands are not queued; they fail immediately.
- `maxRetriesPerRequest: 1`: A command is retried at most once.
- `commandTimeout: 500`: A command that gets no reply fails after 500 ms.

The error is logged, but the logs are not flooded: when the connection drops, `REDIS_CONNECTION_LOST` is written once, and when it comes back, `REDIS_CONNECTION_RESTORED` is written once. `CacheService` and `RedisThrottlerStorage` log command errors at warning level as `CACHE_UNAVAILABLE` and `RATE_LIMIT_STORAGE_UNAVAILABLE`, at most once per minute.

**Why:** Because no value in the cache is needed for correctness (CACHE-05), losing Redis can make the system slower and more expensive, but it must not make it wrong or unavailable. Making Redis required would turn a single helper component into a shared point of failure for the whole API and all workers.

The fail-fast part is at least as important. By default, ioredis buffers commands while there is no connection. In that case the "continue instead of failing" logic never runs, because the command does not fail; it only waits. The same thing happens in a network partition (Redis does not reply, but the connection looks open). These three settings limit the worst-case cost of a command to 500 ms.

The cost of an outage is known and accepted: while Redis is down, different workers can each call the provider for the same content, and rate limiting is disabled. Even with rate limiting off, the credits a user can spend and the number of open jobs are limited in the database (`users.balance`, `users.active_job_count`), so the cost does not grow without bound.

Limiting the log to once per minute keeps the log pipeline from also collapsing during an outage in a system that receives thousands of requests per second.

**Check:** `cache.service.db-spec.ts` (while Redis is down, returns "not there" instead of an error, the warning is written once), `cache-redis.client.db-spec.ts` (connection log, command timeout), `redis-throttler.storage.spec.ts` (while Redis is down, the request is accepted).

## Data

### CACHE-08: Secrets, identity data and user input are not written to the cache

**Rule:** The following data is not written to Redis: passwords and password hashes, access and refresh tokens, session keys, national ID numbers, card data, and the input text the user sends. The result key is the content hash and does not contain the user ID. Redis holds only result text, error codes, lock tokens (a random UUID) and rate limit counters.

**Why:** Redis keeps data in memory without encryption. Its access control is usually not as fine-grained as the database's, and all of it can be read through a memory dump or a wrongly exposed port. The result text is data that is already in the database (CACHE-05). Because the key has no user in it, someone with access to Redis cannot see which result belongs to which user. Putting the hash of the input text in the key instead of the text itself achieves this and also keeps the key length fixed (64 characters).

**Check:** Code review. When a new domain is added, the content of the value is checked against this list.

### CACHE-09: Application code does not do bulk deletes

**Rule:** Application code does not use `KEYS`, bulk deletes with `SCAN`, `FLUSHDB` or `FLUSHALL`. If all keys of a domain need to be invalidated, the key is changed (CACHE-06) or the keys are left to expire. `FLUSHDB` is used only in tests, to empty the test Redis (`test/support` and the `*.db-spec.ts` files under `src/infra/cache`).

**Why:** `KEYS` scans all keys in one go, and during that time Redis runs no other command. With millions of keys, this means the whole API and the workers stall for seconds. In a single DB (CACHE-02), `FLUSHDB` deletes all domains together: results, locks and rate limit counters. Because unchanging values are used, there is no need for bulk deletes anyway.

**Check:** Code review.

### CACHE-10: CacheService stores only strings

**Rule:** The `get` and `set` methods of `CacheService` take and return the value as a `string`. The values stored today are already strings: result text, error code, lock token. If a structured value needs to be stored, the module that writes it converts it to a string itself and validates it with a zod schema when reading.

**Why:** Adding a general-purpose serializer (for example superjson) means a new package and extra work on every read for a need that is not used today (`CODING_STANDARDS.md`, CODE-21). A value read from Redis must be treated like data coming from outside: an older version of the code may have written it in a different format. So for a structured value, validation matters more than type conversion.

**Check:** The signature of `CacheService`.

### CACHE-11: Absence is not cached; a permanent rejection is cached for a short time

**Rule:** "No result" is not written to Redis. The `set` method does not accept `null` or `undefined`. The only exception is when the provider permanently rejects the input (`provider_rejected`): this rejection is written to the `job_failure` domain for 300 seconds. New jobs with the same input fail within this period without going to the provider, and their credits are released. Transient errors (timeout, provider unreachable) are not cached.

**Why:** If "no result" were cached, this record would also have to be deleted as soon as the result is produced (the work CACHE-06 avoids). If the delete were forgotten, the new result would be invisible until the TTL expires.

A permanent rejection is different: if the same input is sent again, the provider will most likely reject it again, and every attempt is a paid call. Remembering it for a short time cuts this cost. The TTL is short because the rejection is not stored in the database and the provider's rules can change. If a transient error were cached, a short provider outage would keep failing jobs even after the outage ended.

**Check:** Code review. `test/job-processing.e2e-spec.ts`: after a rejection, the same input fails without the provider being called.

## Lock

### CACHE-12: Cross-worker call lock

**Rule:** A Redis lock is used to prevent more than one worker from calling the provider at the same time for the same content:

1. The lock is taken with `SET <key> <token> PX <ms> NX`. The token is a new random UUID on every acquisition.
2. The lock TTL is the provider timeout plus 5 seconds (`CALL_LOCK_MARGIN_MS`). After the job is claimed, right before the provider call, the holder restarts the TTL with the same value (`extendLock`, a Lua script that changes the expiry only if the key's value is still this token). The claim can wait on the database, so the lifetime counts from the start of the call. This way the lock does not drop by itself while its owner's call is still running.
3. The lock is released with a Lua script: the key is deleted only if its value is still this token (`RELEASE_LOCK_SCRIPT`).
4. A worker that cannot get the lock checks Redis every 100 ms: if a result or rejection has arrived, it uses that; if the lock was cleared without a result, it tries itself.
5. If Redis is down (`acquireLock` returns `null`), the worker continues without a lock.

The lock only reduces cost. That a job is not completed twice, credits are not taken twice and the result does not change is guaranteed in the database: the job's ownership token (`DATABASE_STANDARDS.md`, DB-15), the "single settlement per job" index (DB-23) and the result written once with the `result IS NULL` condition (CACHE-06).

**Why:** A `DEL` without a token comparison deletes someone else's lock in this case: A's lock expires and drops, B takes the lock, A calls `DEL` when it finishes and removes B's lock. The Lua script prevents this by doing the check and the delete in one atomic step.

A Redis lock does not give strict mutual exclusion: if the worker holding the lock enters a long pause (garbage collection, network drop), the lock expires and a second worker gets in. Redis eviction (CACHE-13) can also delete the lock. So money or state correctness is not tied to the lock. In the rare case the lock misses, the cost is one extra provider call. The first result stays; the second is discarded.

Concurrent jobs inside the same worker never go to the lock; they wait for the shared call in memory (`inFlightCalls`). Because the Kafka message key is the content hash, jobs with the same content usually land on the same worker. The Redis lock is for cases outside this distribution (partition ownership changes, retries).

**Check:** `cache.service.db-spec.ts` (the lock is given to one owner at a time, someone else's lock is not released or extended). `test/job-processing.e2e-spec.ts` (the other worker's call is awaited; if it ends without a result, the worker calls itself; the lock's lifetime counts from the call).

The same lock (`acquireLock`, `extendLock`, `releaseLock`) keeps a user to one streamed export (`export_user`, `API_STANDARDS.md`, API-15). It is renewed every 10 s while the export runs.

### CACHE-14: Leased permits limit work across instances

**Rule:** A limit on how many of something run at once across all instances is a set of leased permits (`acquirePermit`, `renewPermit`, `releasePermit`). Today it limits streamed CSV exports (`export_slots:all`, `EXPORT_MAX_CONCURRENT`).

1. The permits are a sorted set: one member per holder, scored by the time its lease ends.
2. A Lua script takes a permit atomically: it reads the time from Redis (`TIME`), removes members whose lease ended, and adds the holder only if fewer than `limit` remain. A holder that already has a permit gets it again.
3. The holder renews its lease at a third of its length, so one missed renewal does not lose it, and removes itself when done. A crashed holder's permit ends with its lease.
4. Each take and renewal also restarts the key's own expiry (CACHE-04), so the set disappears when nothing holds a permit.
5. If Redis is down (`null`), the caller applies a smaller per-instance limit with a local semaphore (`EXPORT_FALLBACK_MAX_CONCURRENT`), not no limit.

**Why:** A fixed share per instance (limit ÷ instances) is wrong after every scale event, and a counter (`INCR`/`DECR`) leaks a permit for every holder that crashes before it decrements. Expiring members free themselves. Reading the time from Redis, not from each instance, means instance clocks cannot make a lease end early or late. Like the call lock (CACHE-12), the permits do not guard correctness: a lost set (an outage, eviction under `allkeys-lfu`) lets a few more exports run for up to one lease, which costs database load, never wrong data. The fallback exists because the limit protects the database, which matters most exactly when something else has failed.

**Check:** `cache.service.db-spec.ts` (at most `limit` permits; an expired holder frees its permit; only the holder renews; the key expires) and `export-admission.service.spec.ts` (fallback while Redis is down).

## Operations

### CACHE-13: Single Redis, limited memory, LFU eviction, no persistence

**Rule:** Redis runs as a single instance and starts with these settings (`docker-compose.yml`, `cache-redis`):

| Setting | Value |
|---|---|
| `maxmemory` | `256mb` |
| `maxmemory-policy` | `allkeys-lfu` |
| `save` | `''` (RDB off, AOF not enabled) |

There is no separate Redis for the queue; the queue is in Kafka.

**Why:**

- **Limited memory.** An unbounded cache eventually exhausts the machine's memory, and the operating system kills Redis. The limit makes it known in advance how much space the cache will take.
- **`allkeys-lfu`.** When memory fills up, the least frequently used key is deleted. Demand in the result cache is uneven: some content (popular texts, repeated requests) is requested very often, most only once. LRU lets a new value read once push out an old value that is used often. LFU protects the frequently used one. `allkeys-*` is chosen instead of `volatile-*`, because all keys have a TTL (CACHE-04), and `allkeys` prevents memory from filling up and writes from being rejected even if a key without a TTL is written by mistake.
- **No persistence.** Everything in Redis can be rebuilt: results are in the database (CACHE-05), rejections and locks are short-lived, and losing the counters loosens the limit for one window. With disk writes off, Redis runs with lower latency and less disk use. A restarted Redis starts empty and fills up as it is used.

**Note:** If the scale grows and the project moves to Redis Cluster:

- Domains are already in a single DB (CACHE-02), so no key change is needed.
- The Lua script of `RedisThrottlerStorage` touches two keys (`rate_limit:...` and `rate_limit_block:...`). In a cluster, these two keys fall into different slots and the script fails with `CROSSSLOT`. During the move, both keys must be written with the same hash tag (`{...}`).

**Check:** `docker-compose.yml`. The production Redis settings match this table.
