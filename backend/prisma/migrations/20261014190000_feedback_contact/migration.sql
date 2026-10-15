-- SEO round 1 (WP4, owner 2026-10-14): the public contact form extends the
-- existing feedback inbox (kind 'contact': name, reply phone/email, topic) and
-- feedback now carries the owning company. Additive, nullable — safe to roll
-- the API image back (an older client ignores the columns).
ALTER TABLE "feedback_entries" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "feedback_entries" ADD COLUMN IF NOT EXISTS "contactName" TEXT;
ALTER TABLE "feedback_entries" ADD COLUMN IF NOT EXISTS "replyPhone" TEXT;
ALTER TABLE "feedback_entries" ADD COLUMN IF NOT EXISTS "replyEmail" TEXT;
ALTER TABLE "feedback_entries" ADD COLUMN IF NOT EXISTS "topic" TEXT;

-- Existing rows belong to their brand's company.
UPDATE "feedback_entries" f
   SET "tenantId" = c."tenantId"
  FROM "concepts" c
 WHERE f."conceptId" = c."id" AND f."tenantId" IS NULL;

CREATE INDEX IF NOT EXISTS "feedback_entries_tenantId_kind_createdAt_idx"
  ON "feedback_entries" ("tenantId", "kind", "createdAt");
