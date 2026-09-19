-- Split the audit trail in two, and scope it by company.
--
-- Until now one tenant-less table served both "who did what on shift" and
-- "what hit the books", and every finance-tier role in EITHER company could
-- read ALL of it — including the other company's wage changes and journals,
-- across a 60/40 JV with an outside partner.
--
-- Existing rows keep category 'identity' (the default) rather than being
-- guessed at: they are staff-action records in the main, and misfiling a
-- ledger event as an ops one is the safe direction — it narrows who can read
-- it rather than widening it.
ALTER TABLE "audit_logs" ADD COLUMN "category" TEXT NOT NULL DEFAULT 'identity';
ALTER TABLE "audit_logs" ADD COLUMN "tenantId" TEXT;

-- Reclassify the rows that are unambiguously book-keeping, by the action verbs
-- the code actually writes. Anything not named here stays 'identity'.
UPDATE "audit_logs" SET "category" = 'accounting'
WHERE "action" IN (
  'period.close', 'period_lock.removed', 'journal.manual',
  'wage.update', 'tippool.post', 'tippool.distribute'
)
   OR "action" LIKE 'allocation.%'
   OR "action" LIKE 'reconciliation.%';

CREATE INDEX "audit_logs_category_tenantId_createdAt_idx"
  ON "audit_logs" ("category", "tenantId", "createdAt" DESC);
