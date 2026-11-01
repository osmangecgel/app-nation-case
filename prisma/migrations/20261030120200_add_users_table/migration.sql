CREATE TABLE "users" (
    "id" VARCHAR(64) NOT NULL,
    "balance" INTEGER NOT NULL DEFAULT 0,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "active_job_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "users_id_not_empty" CHECK (char_length("id") >= 1),
    -- The last line of defence: no code path can make a balance negative.
    CONSTRAINT "users_balance_non_negative" CHECK ("balance" >= 0),
    CONSTRAINT "users_reserved_non_negative" CHECK ("reserved" >= 0),
    CONSTRAINT "users_active_job_count_non_negative" CHECK ("active_job_count" >= 0)
);
