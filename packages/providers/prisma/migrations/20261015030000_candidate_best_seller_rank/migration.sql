-- Mercado Livre best-seller position seen at discovery (null when the product came from search).
ALTER TABLE "product_candidates" ADD COLUMN "best_seller_rank" INTEGER;
