CREATE TABLE "content_performance" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "content_variant_id" TEXT NOT NULL,
    "publication_attempt_id" TEXT NOT NULL,
    "observed_at" TIMESTAMP(3) NOT NULL,
    "views" INTEGER,
    "reach" INTEGER,
    "likes" INTEGER,
    "comments" INTEGER,
    "shares" INTEGER,
    "saves" INTEGER,
    "profile_visits" INTEGER,
    "platform_url" TEXT,
    CONSTRAINT "content_performance_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "content_performance_workspace_variant_observed_idx" ON "content_performance"("workspace_id", "content_variant_id", "observed_at");
CREATE INDEX "content_performance_attempt_idx" ON "content_performance"("publication_attempt_id");
ALTER TABLE "content_performance" ADD CONSTRAINT "content_performance_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
