-- Generation orchestrator A (2026-10-14). Additive: a new enum value and a new table.
-- Rollback: DROP TABLE "generation_settings"; the MODAL enum value stays (unused values are harmless).
ALTER TYPE "ProviderConnectionProvider" ADD VALUE 'MODAL';

CREATE TABLE "generation_settings" (
    "workspace_id" UUID NOT NULL,
    "monthly_cap_minor" INTEGER NOT NULL,
    "free_credits" JSONB NOT NULL DEFAULT '{}',
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "generation_settings_pkey" PRIMARY KEY ("workspace_id"),
    CONSTRAINT "generation_settings_monthly_cap_minor_check" CHECK ("monthly_cap_minor" >= 0)
);

ALTER TABLE "generation_settings" ADD CONSTRAINT "generation_settings_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
