CREATE TYPE "job_status" AS ENUM ('queued', 'processing', 'completed', 'failed');

CREATE TYPE "job_result_source" AS ENUM ('provider', 'cache', 'coalesced');

CREATE TABLE "jobs" (
    "id" UUID NOT NULL,
    "user_id" VARCHAR(64) NOT NULL,
    "job_content_id" UUID NOT NULL,
    "job_provider_code" VARCHAR(64) NOT NULL,
    "model_version" VARCHAR(64) NOT NULL,
    "status" "job_status" NOT NULL DEFAULT 'queued',
    "cost" INTEGER NOT NULL,
    "error_code" VARCHAR(64),
    "result_source" "job_result_source",
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "run_after" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lock_token" UUID,
    "locked_until" TIMESTAMPTZ(3),
    "dispatched_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatch_count" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "finished_at" TIMESTAMPTZ(3),

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "jobs_cost_positive" CHECK ("cost" > 0),
    CONSTRAINT "jobs_attempt_count_range" CHECK ("attempt_count" BETWEEN 0 AND 10),
    CONSTRAINT "jobs_dispatch_count_non_negative" CHECK ("dispatch_count" >= 0),
    -- Each status carries the fields it needs, and only finished jobs have finished_at.
    CONSTRAINT "jobs_failed_has_error_code" CHECK ("status" <> 'failed' OR "error_code" IS NOT NULL),
    CONSTRAINT "jobs_completed_has_result_source" CHECK ("status" <> 'completed' OR "result_source" IS NOT NULL),
    CONSTRAINT "jobs_processing_has_lease" CHECK ("status" <> 'processing' OR ("lock_token" IS NOT NULL AND "locked_until" IS NOT NULL)),
    CONSTRAINT "jobs_finished_at_matches_status" CHECK (("status" IN ('completed', 'failed')) = ("finished_at" IS NOT NULL))
);

-- List and CSV export, newest first. Ids are UUID v7, so id order is creation order.
CREATE INDEX "jobs_user_id_id_idx" ON "jobs"("user_id", "id" DESC);

-- List filtered by status.
CREATE INDEX "jobs_user_id_status_id_idx" ON "jobs"("user_id", "status", "id" DESC);

CREATE INDEX "jobs_job_content_id_idx" ON "jobs"("job_content_id");

CREATE INDEX "jobs_job_provider_code_idx" ON "jobs"("job_provider_code");

-- Reconciler: leases that expired because the worker died. Only processing rows
-- are indexed, so the index stays small however many finished jobs there are.
CREATE INDEX "jobs_locked_until_processing_idx" ON "jobs"("locked_until") WHERE "status" = 'processing';

-- Reconciler: queued jobs whose last dispatch was never picked up.
CREATE INDEX "jobs_dispatched_at_queued_idx" ON "jobs"("dispatched_at") WHERE "status" = 'queued';

ALTER TABLE "jobs" ADD CONSTRAINT "jobs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_job_content_id_fkey" FOREIGN KEY ("job_content_id") REFERENCES "job_contents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_job_provider_code_fkey" FOREIGN KEY ("job_provider_code") REFERENCES "job_providers"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
