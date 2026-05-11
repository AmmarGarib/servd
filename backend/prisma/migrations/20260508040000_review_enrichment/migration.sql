-- Post-order rating system: enriched OrderReview + Order tracking field for
-- the review-prompt worker.
--
-- New columns are all nullable / defaulted so existing reviews + orders keep
-- working unchanged.

-- ── OrderReview enrichment ──────────────────────────────────────────────────
ALTER TABLE "order_reviews"
  ADD COLUMN "categoryRatings"     JSONB,
  ADD COLUMN "tags"                TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "isPositive"          BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "bonusPointsAwarded"  INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "managerResponse"     TEXT,
  ADD COLUMN "managerResponseAt"   TIMESTAMP(3),
  ADD COLUMN "managerResponseById" TEXT;

-- Backfill isPositive flag for existing rows so reports work immediately.
UPDATE "order_reviews"
   SET "isPositive" = ("rating" >= 4);

CREATE INDEX "order_reviews_conceptId_createdAt_idx"
  ON "order_reviews" ("conceptId", "createdAt");

CREATE INDEX "order_reviews_conceptId_rating_idx"
  ON "order_reviews" ("conceptId", "rating");

-- ── Order: prompt-sent tracking ─────────────────────────────────────────────
ALTER TABLE "orders"
  ADD COLUMN "reviewPromptSentAt" TIMESTAMP(3);
