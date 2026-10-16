CREATE TYPE "PublicationPolicyMode" AS ENUM ('MANUAL', 'POLICY_BASED', 'PAUSED');

CREATE TABLE "publication_policies" (
    "workspace_id" UUID NOT NULL,
    "mode" "PublicationPolicyMode" NOT NULL DEFAULT 'MANUAL',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "publication_policies_pkey" PRIMARY KEY ("workspace_id")
);

ALTER TABLE "publication_policies" ADD CONSTRAINT "publication_policies_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
