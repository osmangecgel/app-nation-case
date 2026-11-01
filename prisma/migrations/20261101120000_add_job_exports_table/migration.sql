-- Background CSV exports (EXPORT_MODE async or auto) and their dispatch through
-- the existing outbox.

CREATE TYPE "job_export_status" AS ENUM ('queued', 'processing', 'ready', 'failed', 'canceled', 'expired');

CREATE TABLE "job_exports" (
    "id" UUID NOT NULL,
    "user_id" VARCHAR(64) NOT NULL,
    "status" "job_export_status" NOT NULL DEFAULT 'queued',
    "file_key" VARCHAR(255),
    "row_count" INTEGER,
    "error_code" VARCHAR(64),
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "run_after" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lock_token" UUID,
    "locked_until" TIMESTAMPTZ(3),
    "dispatched_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatch_count" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "finished_at" TIMESTAMPTZ(3),
    "expires_at" TIMESTAMPTZ(3),

    CONSTRAINT "job_exports_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "job_exports_attempt_count_range" CHECK ("attempt_count" BETWEEN 0 AND 10),
    CONSTRAINT "job_exports_dispatch_count_non_negative" CHECK ("dispatch_count" >= 0),
    CONSTRAINT "job_exports_row_count_non_negative" CHECK ("row_count" >= 0),
    -- Each status carries the fields it needs.
    CONSTRAINT "job_exports_ready_has_file" CHECK ("status" <> 'ready' OR ("file_key" IS NOT NULL AND "row_count" IS NOT NULL AND "expires_at" IS NOT NULL)),
    CONSTRAINT "job_exports_failed_has_error_code" CHECK ("status" <> 'failed' OR "error_code" IS NOT NULL),
    CONSTRAINT "job_exports_processing_has_lease" CHECK ("status" <> 'processing' OR ("lock_token" IS NOT NULL AND "locked_until" IS NOT NULL)),
    CONSTRAINT "job_exports_finished_at_matches_status" CHECK (("status" IN ('queued', 'processing')) = ("finished_at" IS NULL))
);

CREATE INDEX "job_exports_user_id_id_idx" ON "job_exports"("user_id", "id" DESC);

-- One unfinished export per user: a second request gets the first one back
-- (INSERT ... ON CONFLICT on this index), and two cannot run side by side.
CREATE UNIQUE INDEX "job_exports_one_active_per_user_idx" ON "job_exports"("user_id") WHERE "status" IN ('queued', 'processing');

-- Maintenance: expired leases, sends nobody received, files past their expiry.
CREATE INDEX "job_exports_locked_until_processing_idx" ON "job_exports"("locked_until") WHERE "status" = 'processing';
CREATE INDEX "job_exports_dispatched_at_queued_idx" ON "job_exports"("dispatched_at") WHERE "status" = 'queued';
CREATE INDEX "job_exports_expires_at_ready_idx" ON "job_exports"("expires_at") WHERE "status" = 'ready';

ALTER TABLE "job_exports" ADD CONSTRAINT "job_exports_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The outbox carries export dispatches too: exactly one of job_id and export_id.
ALTER TABLE "job_outbox_messages" ALTER COLUMN "job_id" DROP NOT NULL;
ALTER TABLE "job_outbox_messages" ADD COLUMN "export_id" UUID;
ALTER TABLE "job_outbox_messages" ADD CONSTRAINT "job_outbox_messages_one_subject" CHECK (num_nonnulls("job_id", "export_id") = 1);
CREATE INDEX "job_outbox_messages_export_id_idx" ON "job_outbox_messages"("export_id");
ALTER TABLE "job_outbox_messages" ADD CONSTRAINT "job_outbox_messages_export_id_fkey" FOREIGN KEY ("export_id") REFERENCES "job_exports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
