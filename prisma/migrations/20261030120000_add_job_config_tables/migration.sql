-- Job configuration: which job types exist, which providers serve them and on what terms.
-- Small, read-mostly tables; the app loads them into memory.

CREATE TABLE "job_types" (
    "code" VARCHAR(32) NOT NULL,
    "cost" INTEGER NOT NULL,
    "max_input_chars" INTEGER NOT NULL,
    "input_formats" VARCHAR(32)[] NOT NULL,
    "prompt_version" VARCHAR(32) NOT NULL,
    "max_attempt_count" INTEGER NOT NULL,
    "timeout_ms" INTEGER NOT NULL,
    "cache_ttl_seconds" INTEGER NOT NULL,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "job_types_pkey" PRIMARY KEY ("code"),
    CONSTRAINT "job_types_cost_positive" CHECK ("cost" > 0),
    -- The upper bound guards against a typo; the real limit is the configured value.
    CONSTRAINT "job_types_max_input_chars_range" CHECK ("max_input_chars" BETWEEN 1 AND 1000000),
    CONSTRAINT "job_types_input_formats_not_empty" CHECK (cardinality("input_formats") >= 1),
    CONSTRAINT "job_types_max_attempt_count_range" CHECK ("max_attempt_count" BETWEEN 1 AND 10),
    CONSTRAINT "job_types_timeout_ms_positive" CHECK ("timeout_ms" > 0),
    CONSTRAINT "job_types_cache_ttl_seconds_non_negative" CHECK ("cache_ttl_seconds" >= 0)
);

CREATE TABLE "job_providers" (
    "code" VARCHAR(64) NOT NULL,
    "adapter" VARCHAR(64) NOT NULL,
    "max_concurrency" INTEGER NOT NULL,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "job_providers_pkey" PRIMARY KEY ("code"),
    CONSTRAINT "job_providers_max_concurrency_positive" CHECK ("max_concurrency" > 0)
);

CREATE TABLE "job_type_routes" (
    "job_type_code" VARCHAR(32) NOT NULL,
    "job_provider_code" VARCHAR(64) NOT NULL,
    "model_version" VARCHAR(64) NOT NULL,
    "weight" INTEGER NOT NULL,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "job_type_routes_pkey" PRIMARY KEY ("job_type_code","job_provider_code","model_version"),
    CONSTRAINT "job_type_routes_weight_non_negative" CHECK ("weight" >= 0)
);

CREATE INDEX "job_type_routes_job_provider_code_idx" ON "job_type_routes"("job_provider_code");

ALTER TABLE "job_type_routes" ADD CONSTRAINT "job_type_routes_job_type_code_fkey" FOREIGN KEY ("job_type_code") REFERENCES "job_types"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "job_type_routes" ADD CONSTRAINT "job_type_routes_job_provider_code_fkey" FOREIGN KEY ("job_provider_code") REFERENCES "job_providers"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
