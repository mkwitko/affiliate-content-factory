ALTER TABLE "content_variants"
ADD COLUMN "canva_design_id" TEXT,
ADD COLUMN "canva_pages" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
ADD COLUMN "canva_width" INTEGER,
ADD COLUMN "canva_height" INTEGER;
