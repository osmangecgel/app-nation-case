# AI jobs with credits

Design: [docs/design.md](docs/design.md); pluggable broker and provider in [section 15](docs/design.md#15-adding-a-broker-or-a-provider), concurrent exports in [section 16](docs/design.md#16-exports-at-scale).

## Setup and test (Docker only)

Node.js 24.22, PostgreSQL 17.11, Redis 7.4, Kafka 4.1.

```bash
docker compose up -d --build            # API on :13400, worker, PostgreSQL, Redis, Kafka (.env optional)
docker compose run --rm seed            # 500,000 jobs for "seed-user" (~2 min)
docker compose run --rm verify --help   # lists the checks; run any by name: verify flaky hang
docker compose run --rm verify all      # credits, repeat, fail, flaky, hang, same-text, limit, crash, balances
docker compose run --rm verify export   # 500,000-job CSV read at 50 KB/s
docker compose run --rm test            # automated tests, including the case's (a), (b), (c)
```

Swagger: http://localhost:13400/docs. Errors: RFC 9457 with the case's `error`.

## Delivery guarantee

At-least-once; credits exactly once (writes fenced by a lease token). The provider may be called twice if a worker dies between the answer and its Redis write, a stalled worker loses its lease, Redis is down, or a transient error is retried.

## Idempotency and credits under concurrency

One transaction claims the key (`ON CONFLICT DO NOTHING`; concurrent duplicates wait, then replay), writes the job and outbox row, and reserves via `UPDATE … WHERE balance >= cost`: no read-then-write race. A 402 rolls all back. Balance and ledger change in one statement. Max 50 unfinished jobs per user (429). Redis holds no credits or keys: only caches, locks and limits.

## Worker crash recovery

The 15-second lease expires and the reconciler requeues the job. Verified by `verify crash` (worker killed mid-job: completed, one capture).

## Indexes, constraints, EXPLAIN ANALYZE

- Indexes `(user_id, id DESC)`, `(user_id, status, id DESC)`; UUID v7 keyset cursor.
- CHECKs: non-negative balances, positive amounts. Partial unique indexes: one reserve, one capture-or-release per job. Primary key `(user_id, idempotency_key)`.

500,000-job user; first page, then 250,000 rows deep with a status filter:

```
Limit  (cost=0.42..3.86 rows=21 width=74) (actual time=0.086..0.107 rows=21 loops=1)
  ->  Index Scan using jobs_user_id_id_idx on jobs  (cost=0.42..81682.00 rows=499690 width=74) (actual time=0.085..0.104 rows=21 loops=1)
        Index Cond: ((user_id)::text = 'seed-user'::text)
Planning Time: 1.651 ms
Execution Time: 0.163 ms

Limit  (cost=0.42..33.68 rows=21 width=74) (actual time=0.109..0.203 rows=21 loops=1)
  ->  Index Scan using jobs_user_id_status_id_idx on jobs  (cost=0.42..33552.31 rows=21189 width=74) (actual time=0.108..0.201 rows=21 loops=1)
        Index Cond: (((user_id)::text = 'seed-user'::text) AND (status = 'failed'::job_status) AND (id < '019fc313-875f-71b9-8b18-21e0b92b974a'::uuid))
Planning Time: 1.987 ms
Execution Time: 0.255 ms
```

Reasons: design.md sections 3, 12.

## Metrics

1. Oldest due job's age.
2. Provider outcome rates and p95 latency.
3. Users whose balance disagrees with the ledger.

## Time spent, known gaps

About 2 days, from the evening of 30 October to 1 November 2026. Gaps:
- Global provider limit (20) not enforced; per-worker only.
- No automated test through a real Kafka broker.
- `flaky` counter is per worker process.

---

## Bonus: global limit, cancellation, cost

- **Global limit:** a leased Redis semaphore (sorted set and Lua: drop expired holders, check the count, add). It is renewed while tokens stream and released in `finally`, and a crashed pod's permit expires. Jobs are claimed only after a permit is held. If Redis is down, fall back to `floor(20 / max pods)` per pod.
- **Cancellation:** one `AbortController` per call combines the timeout, lease loss, shutdown and user cancel. Aborting closes the stream, so the provider stops generating tokens.
- **Cost:** reserve the worst case (`max_tokens` × price). When the stream ends, capture the actual tokens and release the rest. Enforce `max_tokens` on every call and keep the content-hash cache in front of the provider.
- **Overload:** when the oldest due job's age passes a threshold, answer new jobs with 503 and `Retry-After`.

## AI use

I used Claude Code to write most of the code, tests and docs, under my design decisions (Kafka with an outbox, late claim, fencing tokens, the queue and provider ports) and review. I verified its output with database-backed tests, the case's verification flow (scripted, then run by hand) and ledger consistency checks; this found and fixed real bugs (head-of-line blocking, a lost result on early Redis write, connections closing before the shutdown grace period).
