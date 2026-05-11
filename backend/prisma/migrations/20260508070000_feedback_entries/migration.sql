-- One-tap NPS / CSAT / open-suggestion feedback. Distinct from OrderReview
-- (tied to a specific order) and OrderComplaint (formal grievance). Powers
-- the global feedback widget on the storefront and the post-order CSAT.

CREATE TABLE "feedback_entries" (
  "id"          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "customerId"  TEXT,
  "conceptId"   TEXT,
  "kind"        TEXT NOT NULL,
  "score"       INTEGER,
  "comment"     TEXT,
  "context"     JSONB,
  "source"      TEXT NOT NULL DEFAULT 'storefront',
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "feedback_entries_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL,
  CONSTRAINT "feedback_entries_conceptId_fkey"
    FOREIGN KEY ("conceptId") REFERENCES "concepts"("id") ON DELETE SET NULL
);

CREATE INDEX "feedback_entries_conceptId_createdAt_idx"
  ON "feedback_entries" ("conceptId", "createdAt");

CREATE INDEX "feedback_entries_customerId_createdAt_idx"
  ON "feedback_entries" ("customerId", "createdAt");
