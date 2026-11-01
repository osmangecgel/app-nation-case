CREATE TABLE "job_idempotency_keys" (
    "user_id" VARCHAR(64) NOT NULL,
    "idempotency_key" VARCHAR(255) NOT NULL,
    "request_hash" BYTEA NOT NULL,
    "job_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    -- Concurrent requests with the same key: the second waits on this key until
    -- the first commits or rolls back, so only one job is ever created.
    CONSTRAINT "job_idempotency_keys_pkey" PRIMARY KEY ("user_id","idempotency_key"),
    CONSTRAINT "job_idempotency_keys_key_not_empty" CHECK (char_length("idempotency_key") >= 1),
    CONSTRAINT "job_idempotency_keys_request_hash_sha256" CHECK (octet_length("request_hash") = 32),
    CONSTRAINT "job_idempotency_keys_expires_after_created" CHECK ("expires_at" > "created_at")
);

CREATE UNIQUE INDEX "job_idempotency_keys_job_id_key" ON "job_idempotency_keys"("job_id");

-- Cleanup of expired keys.
CREATE INDEX "job_idempotency_keys_expires_at_idx" ON "job_idempotency_keys"("expires_at");

ALTER TABLE "job_idempotency_keys" ADD CONSTRAINT "job_idempotency_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Checked at commit: the key is claimed first, so a concurrent request with the
-- same key waits before any work is done, and the job it points to is inserted
-- later in the same transaction.
ALTER TABLE "job_idempotency_keys" ADD CONSTRAINT "job_idempotency_keys_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;
