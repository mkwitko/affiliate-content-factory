-- Canva OAuth connections use the existing provider connection shape.
-- The enum extension is intentionally additive; tokens remain in SecretRecord.
ALTER TYPE "ProviderConnectionProvider" ADD VALUE IF NOT EXISTS 'CANVA';
