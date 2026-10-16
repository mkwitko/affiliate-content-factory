ALTER TABLE "long_form_renders"
  ADD COLUMN "timing_manifest" JSONB,
  ADD CONSTRAINT "long_form_renders_timing_manifest_object_check"
    CHECK ("timing_manifest" IS NULL OR jsonb_typeof("timing_manifest") = 'object');
