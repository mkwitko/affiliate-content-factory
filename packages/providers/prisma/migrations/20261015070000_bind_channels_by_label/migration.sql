-- Bind existing channels to the niche whose name prefixes their label, e.g. "Example Shop Home
-- — Instagram Feed" to the niche "Example Shop Home". Only unbound channels with exactly one
-- matching niche in their workspace; anything else stays null for set_channel_niche.
UPDATE "channels" AS c
SET "niche_id" = m."niche_id"
FROM (
  SELECT c2."id" AS "channel_id", MIN(n."id") AS "niche_id"
  FROM "channels" AS c2
  JOIN "niches" AS n
    ON n."workspace_id" = c2."workspace_id"
   AND c2."label" LIKE n."name" || ' — %'
  WHERE c2."niche_id" IS NULL
  GROUP BY c2."id"
  HAVING COUNT(*) = 1
) AS m
WHERE c."id" = m."channel_id";
