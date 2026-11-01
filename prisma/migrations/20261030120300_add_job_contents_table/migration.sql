CREATE TABLE "job_contents" (
    "id" UUID NOT NULL,
    "job_type_code" VARCHAR(32) NOT NULL,
    "content_hash" BYTEA NOT NULL,
    "input" TEXT NOT NULL,
    "result" TEXT,
    "result_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "job_contents_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "job_contents_content_hash_sha256" CHECK (octet_length("content_hash") = 32),
    CONSTRAINT "job_contents_input_length" CHECK (char_length("input") BETWEEN 1 AND 1000000),
    CONSTRAINT "job_contents_result_at_matches_result" CHECK (("result" IS NULL) = ("result_at" IS NULL))
);

-- Same type and same content share one row, so a summary and a translation of
-- the same text can never be mixed up.
CREATE UNIQUE INDEX "job_contents_job_type_code_content_hash_key" ON "job_contents"("job_type_code", "content_hash");

-- lz4 compresses and decompresses faster than the default pglz.
ALTER TABLE "job_contents" ALTER COLUMN "input" SET COMPRESSION lz4;
ALTER TABLE "job_contents" ALTER COLUMN "result" SET COMPRESSION lz4;

ALTER TABLE "job_contents" ADD CONSTRAINT "job_contents_job_type_code_fkey" FOREIGN KEY ("job_type_code") REFERENCES "job_types"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
