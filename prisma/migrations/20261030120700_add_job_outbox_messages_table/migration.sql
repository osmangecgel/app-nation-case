CREATE TABLE "job_outbox_messages" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "topic" VARCHAR(128) NOT NULL,
    -- Kafka message key: jobs with the same content land on the same partition.
    "message_key" VARCHAR(128) NOT NULL,
    "request_id" VARCHAR(64) NOT NULL,
    "not_before" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_outbox_messages_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "job_outbox_messages_job_id_idx" ON "job_outbox_messages"("job_id");

-- Relay: unsent messages that are due. Only unsent rows are indexed, so the
-- relay query stays fast however many sent rows are waiting for cleanup.
CREATE INDEX "job_outbox_messages_pending_idx" ON "job_outbox_messages"("not_before") WHERE "sent_at" IS NULL;

-- Cleanup of sent messages.
CREATE INDEX "job_outbox_messages_sent_at_idx" ON "job_outbox_messages"("sent_at") WHERE "sent_at" IS NOT NULL;

ALTER TABLE "job_outbox_messages" ADD CONSTRAINT "job_outbox_messages_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
