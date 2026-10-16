CREATE TABLE "canva_designs" ("id" TEXT NOT NULL, "workspace_id" UUID NOT NULL, "design_id" TEXT NOT NULL, "variant_id" TEXT NOT NULL, "pages" JSONB NOT NULL, "actor_id" UUID NOT NULL, "updated_at" TIMESTAMP(3) NOT NULL, CONSTRAINT "canva_designs_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX "canva_designs_workspace_design_key" ON "canva_designs"("workspace_id", "design_id");
ALTER TABLE "canva_designs" ADD CONSTRAINT "canva_designs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
