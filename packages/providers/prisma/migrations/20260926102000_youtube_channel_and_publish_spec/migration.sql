ALTER TYPE "ChannelKind" ADD VALUE 'YOUTUBE';

ALTER TABLE "content_variants"
  ADD COLUMN "publish_spec" JSONB;
ALTER TABLE "assets"
  ADD COLUMN "duration_ms" INTEGER,
  ADD COLUMN "byte_size" INTEGER;
