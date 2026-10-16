CREATE TABLE "tracking_redirects" ("slug" TEXT NOT NULL, "workspace_id" UUID NOT NULL, "destination" TEXT NOT NULL, "destination_fingerprint" TEXT NOT NULL, "expires_at" TIMESTAMP(3) NOT NULL, CONSTRAINT "tracking_redirects_pkey" PRIMARY KEY ("slug"));
CREATE TABLE "tracking_clicks" ("id" TEXT NOT NULL, "slug" TEXT NOT NULL, "event_id" TEXT NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "tracking_clicks_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX "tracking_clicks_slug_event_key" ON "tracking_clicks"("slug", "event_id");
ALTER TABLE "tracking_redirects" ADD CONSTRAINT "tracking_redirects_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
