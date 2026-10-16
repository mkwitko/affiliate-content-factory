-- The niche profile a channel publishes for; null until the owner binds it (set_channel_niche).
ALTER TABLE "channels" ADD COLUMN "niche_id" TEXT;
ALTER TABLE "channels" ADD CONSTRAINT "channels_niche_id_fkey" FOREIGN KEY ("niche_id") REFERENCES "niches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
