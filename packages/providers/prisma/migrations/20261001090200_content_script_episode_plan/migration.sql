-- Advisory story plan on a script (Stickman v2 slice 30). Nullable: existing rows stay valid.
ALTER TABLE "content_scripts" ADD COLUMN "episode_plan" JSONB;
