-- 20261017110000_sales_deposit_drop_shifts — one bank bag split across several
-- till shifts (owner, 2026-10-16: "One deposit can be split across several
-- shifts. The night audit compares amounts, not just 'a deposit exists'").
--
-- deposit_drop_shifts: how much of a drop came from each shift (Σ = the
-- drop's amount, checked by the route). Stamped with the DROP's company.
-- Every existing drop that names a shift gets one row for its whole amount,
-- so the readers (accounting/depositPosting.ts dropAllocations, the night
-- audit's cash_not_banked, the daily report, sales_bank_unmatched) read one
-- source. deposit_drops.shiftId stays (set when a drop has exactly one shift).
--
-- Runbook: if this migration fails on deploy, run
--   prisma migrate resolve --rolled-back 20261017110000_sales_deposit_drop_shifts
-- in the api image before redeploying any image (P3009 blocks every image).
-- Rollback: an older image ignores the table; a split drop then reads as its
-- legacy shiftId only (null for a multi-shift drop) — safe, no money moves.
SET lock_timeout = '10s';

CREATE TABLE "deposit_drop_shifts" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "depositDropId" TEXT NOT NULL,
  "shiftId" TEXT NOT NULL,
  "amountCents" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "deposit_drop_shifts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "deposit_drop_shifts_depositDropId_shiftId_key" ON "deposit_drop_shifts"("depositDropId", "shiftId");
CREATE INDEX "deposit_drop_shifts_tenantId_shiftId_idx" ON "deposit_drop_shifts"("tenantId", "shiftId");
CREATE INDEX "deposit_drop_shifts_shiftId_idx" ON "deposit_drop_shifts"("shiftId");

ALTER TABLE "deposit_drop_shifts" ADD CONSTRAINT "deposit_drop_shifts_depositDropId_fkey"
  FOREIGN KEY ("depositDropId") REFERENCES "deposit_drops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill: one allocation per legacy drop that names a shift (company-less drops are skipped).
INSERT INTO "deposit_drop_shifts" ("id", "tenantId", "depositDropId", "shiftId", "amountCents", "createdAt")
SELECT 'dds_' || d."id", d."tenantId", d."id", d."shiftId", d."amountCents", d."droppedAt"
  FROM "deposit_drops" d
 WHERE d."shiftId" IS NOT NULL AND d."tenantId" IS NOT NULL AND d."amountCents" > 0
ON CONFLICT DO NOTHING;

-- ─── SQL-only objects (one statement per ';', no trailing comments)
ALTER TABLE "deposit_drop_shifts" ADD CONSTRAINT "deposit_drop_shifts_amount_chk" CHECK ("amountCents" > 0);

-- ─── Row-level security (the guarded wave-A/B pattern, as 20261016140000_notifications)
DO $do$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'app_is_service_mode')
     AND EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'app_tenant_ids') THEN
    FOREACH t IN ARRAY ARRAY['deposit_drop_shifts']
    LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename = t) THEN
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format(
          'CREATE POLICY %I ON %I FOR ALL '
          'USING (app_is_service_mode() OR %I."tenantId" = ANY(app_tenant_ids())) '
          'WITH CHECK (app_is_service_mode() OR %I."tenantId" = ANY(app_tenant_ids()))',
          t || '_rls', t, t, t);
      END IF;
    END LOOP;
  END IF;
END
$do$;
