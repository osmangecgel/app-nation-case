-- The job types and prices the case defines. They are part of the schema, not
-- sample data: the API rejects unknown types, so a fresh `docker compose up`
-- needs them before any seed script runs.

INSERT INTO "job_types" ("code", "cost", "max_input_chars", "input_formats", "prompt_version", "max_attempt_count", "timeout_ms", "cache_ttl_seconds", "updated_at") VALUES
    ('summary',   3, 20000, '{text}', 'v1', 3, 10000, 3600, CURRENT_TIMESTAMP),
    ('translate', 1, 20000, '{text}', 'v1', 3, 10000, 3600, CURRENT_TIMESTAMP);

INSERT INTO "job_providers" ("code", "adapter", "max_concurrency", "updated_at") VALUES
    ('fake-text', 'fake', 20, CURRENT_TIMESTAMP);

INSERT INTO "job_type_routes" ("job_type_code", "job_provider_code", "model_version", "weight", "updated_at") VALUES
    ('summary',   'fake-text', 'fake-v1', 100, CURRENT_TIMESTAMP),
    ('translate', 'fake-text', 'fake-v1', 100, CURRENT_TIMESTAMP);
