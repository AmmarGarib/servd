-- SEO round 1 (owner, 2026-10-14): the brand's public profile links live on
-- the brand record, edited in Marketing → Brands. Additive, nullable/defaulted
-- — safe to roll the API image back (an older client ignores the columns).
ALTER TABLE "concepts" ADD COLUMN IF NOT EXISTS "sameAs" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "concepts" ADD COLUMN IF NOT EXISTS "googleMapsUrl" TEXT;
