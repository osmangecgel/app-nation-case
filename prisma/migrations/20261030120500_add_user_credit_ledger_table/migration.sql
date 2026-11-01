CREATE TYPE "user_credit_entry_type" AS ENUM ('grant', 'reserve', 'capture', 'release');

-- Append-only record of every balance change.
CREATE TABLE "user_credit_ledger" (
    "id" UUID NOT NULL,
    "user_id" VARCHAR(64) NOT NULL,
    "job_id" UUID,
    "entry_type" "user_credit_entry_type" NOT NULL,
    "amount" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_credit_ledger_pkey" PRIMARY KEY ("id"),
    -- The direction comes from entry_type, so amounts are always positive.
    CONSTRAINT "user_credit_ledger_amount_positive" CHECK ("amount" > 0),
    -- Grants are not tied to a job; every other entry is.
    CONSTRAINT "user_credit_ledger_job_id_matches_entry_type" CHECK (("entry_type" = 'grant') = ("job_id" IS NULL))
);

CREATE INDEX "user_credit_ledger_user_id_idx" ON "user_credit_ledger"("user_id");

-- Every foreign key has a plain index (DB-08). The partial unique indexes below
-- do not count: the check run when a job is deleted cannot use them.
CREATE INDEX "user_credit_ledger_job_id_idx" ON "user_credit_ledger"("job_id");

-- One reservation per job.
CREATE UNIQUE INDEX "user_credit_ledger_reserve_once_idx" ON "user_credit_ledger"("job_id") WHERE "entry_type" = 'reserve';

-- A reservation is settled at most once: either captured or released, never both,
-- never twice. Two workers finishing the same job cannot both write here.
CREATE UNIQUE INDEX "user_credit_ledger_settle_once_idx" ON "user_credit_ledger"("job_id") WHERE "entry_type" IN ('capture', 'release');

ALTER TABLE "user_credit_ledger" ADD CONSTRAINT "user_credit_ledger_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "user_credit_ledger" ADD CONSTRAINT "user_credit_ledger_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
