ALTER TABLE "home_worker_tokens" ADD COLUMN "heartbeat" JSONB,
ADD COLUMN "heartbeat_at" TIMESTAMP(3);
