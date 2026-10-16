-- Post-render quality gate report (packages/core/src/publishing/render-quality.ts).
-- Nullable: renders made before the gate read as "not measured".
ALTER TABLE "reel_renders" ADD COLUMN "quality_report" JSONB;
ALTER TABLE "long_form_renders" ADD COLUMN "quality_report" JSONB;
