CREATE TABLE "video_storyboards" (
  "id" TEXT NOT NULL,
  "workspace_id" UUID NOT NULL,
  "content_item_id" TEXT NOT NULL,
  "script_id" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "scenes" JSONB NOT NULL,
  "voice_id" TEXT NOT NULL,
  "music_track_id" TEXT,
  "canvas" TEXT NOT NULL,
  "checksum" TEXT NOT NULL,
  "actor_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "video_storyboards_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "video_storyboards_canvas_check" CHECK ("canvas" IN ('landscape', 'portrait')),
  CONSTRAINT "video_storyboards_workspace_script_version_key" UNIQUE ("workspace_id", "script_id", "version"),
  CONSTRAINT "video_storyboards_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE,
  CONSTRAINT "video_storyboards_content_item_id_fkey" FOREIGN KEY ("content_item_id") REFERENCES "content_items"("id") ON DELETE CASCADE,
  CONSTRAINT "video_storyboards_script_id_fkey" FOREIGN KEY ("script_id") REFERENCES "content_scripts"("id") ON DELETE RESTRICT,
  CONSTRAINT "video_storyboards_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT
);
CREATE INDEX "video_storyboards_workspace_script_idx" ON "video_storyboards"("workspace_id", "script_id", "version");

CREATE TABLE "long_form_renders" (
  "id" TEXT NOT NULL,
  "workspace_id" UUID NOT NULL,
  "storyboard_id" TEXT NOT NULL,
  "attempt" INTEGER NOT NULL DEFAULT 1,
  "status" "ReelRenderStatus" NOT NULL DEFAULT 'PENDING',
  "reason" TEXT,
  "asset_id" TEXT,
  "duration_ms" INTEGER,
  "wall_time_ms" INTEGER,
  "renderer_version" INTEGER NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "long_form_renders_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "long_form_renders_workspace_storyboard_attempt_key" UNIQUE ("workspace_id", "storyboard_id", "attempt"),
  CONSTRAINT "long_form_renders_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE,
  CONSTRAINT "long_form_renders_storyboard_id_fkey" FOREIGN KEY ("storyboard_id") REFERENCES "video_storyboards"("id") ON DELETE RESTRICT
);
CREATE INDEX "long_form_renders_workspace_status_idx" ON "long_form_renders"("workspace_id", "status");
