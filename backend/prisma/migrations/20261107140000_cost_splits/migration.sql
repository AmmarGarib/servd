-- 20261107140000_cost_splits — split an already-booked expense / a processed
-- payroll between servd companies (owner, 2026-11-07: "Build a split option to
-- split cost/payroll/expenses into FLIPD and GS Foods or any other company …
-- in % and in amount, an expense already booked, Payroll already processed
-- should also have option to split"). Owner decisions: EXTEND the existing
-- inter-company engine (no second ledger, no new transfer table); finance
-- posts directly (the CEO is told on the bell).
--
-- cost_splits: tenantId = the SOURCE company. cost_split_shares: tenantId =
-- the RECEIVING company; each share is ONE intercompany_transfers row (kind
-- charge, source 'cost_split'), so ic_source_chk learns 'cost_split'.
-- One POSTED split per source entry (partial unique index). Nothing is dropped.
--
-- Runbook: if this migration fails on deploy, run
--   prisma migrate resolve --rolled-back 20261107140000_cost_splits
-- in the api image before redeploying any image (P3009 blocks every image).
-- Rollback: once a 'cost_split' transfer exists an older image still reads it
-- (source is TEXT); do not roll the CHECK back while one exists.
SET lock_timeout = '10s';

CREATE TABLE "cost_splits" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "sourceKind" TEXT NOT NULL,
  "sourceEntryId" TEXT NOT NULL,
  "payrollRunId" TEXT,
  "mode" TEXT NOT NULL,
  "baseCents" BIGINT NOT NULL,
  "splitCents" BIGINT NOT NULL,
  "lines" JSONB NOT NULL,
  "entryDate" TIMESTAMP(3) NOT NULL,
  "memo" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'posted',
  "createdById" TEXT NOT NULL,
  "reversedById" TEXT,
  "reversedAt" TIMESTAMP(3),
  "reversalReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "cost_splits_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "cost_splits_tenantId_status_idx" ON "cost_splits"("tenantId", "status");
CREATE INDEX "cost_splits_sourceEntryId_idx" ON "cost_splits"("sourceEntryId");
CREATE INDEX "cost_splits_payrollRunId_idx" ON "cost_splits"("payrollRunId");

CREATE TABLE "cost_split_shares" (
  "id" TEXT NOT NULL,
  "splitId" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "percentBp" INTEGER,
  "amountCents" BIGINT NOT NULL,
  "lines" JSONB NOT NULL,
  "intercompanyTransferId" TEXT NOT NULL,
  CONSTRAINT "cost_split_shares_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "cost_split_shares_intercompanyTransferId_key" ON "cost_split_shares"("intercompanyTransferId");
CREATE UNIQUE INDEX "cost_split_shares_splitId_tenantId_key" ON "cost_split_shares"("splitId", "tenantId");
CREATE INDEX "cost_split_shares_tenantId_idx" ON "cost_split_shares"("tenantId");

ALTER TABLE "cost_split_shares" ADD CONSTRAINT "cost_split_shares_splitId_fkey" FOREIGN KEY ("splitId") REFERENCES "cost_splits"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "intercompany_transfers" DROP CONSTRAINT IF EXISTS "ic_source_chk";

-- ─── SQL-only objects (one statement per ';', no trailing comments)
CREATE UNIQUE INDEX "cost_splits_one_posted_per_entry" ON "cost_splits"("sourceEntryId") WHERE "status" = 'posted';
ALTER TABLE "cost_splits" ADD CONSTRAINT "cost_splits_kind_chk" CHECK ("sourceKind" IN ('journal_entry', 'payroll_run') AND ("sourceKind" = 'payroll_run') = ("payrollRunId" IS NOT NULL));
ALTER TABLE "cost_splits" ADD CONSTRAINT "cost_splits_mode_chk" CHECK ("mode" IN ('percent', 'amount'));
ALTER TABLE "cost_splits" ADD CONSTRAINT "cost_splits_status_chk" CHECK ("status" IN ('posted', 'reversed'));
ALTER TABLE "cost_splits" ADD CONSTRAINT "cost_splits_amount_chk" CHECK ("baseCents" > 0 AND "splitCents" > 0 AND "splitCents" <= "baseCents");
ALTER TABLE "cost_split_shares" ADD CONSTRAINT "cost_split_shares_amount_chk" CHECK ("amountCents" > 0 AND ("percentBp" IS NULL OR ("percentBp" > 0 AND "percentBp" <= 10000)));
ALTER TABLE "intercompany_transfers" ADD CONSTRAINT "ic_source_chk" CHECK ("source" IN ('manual', 'fleet', 'cod', 'ho_recharge', 'asset_transfer', 'cost_split'));

-- ─── Row-level security (the guarded wave-A/B pattern, as 20261105190000_employee_delete_requests).
DO $do$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'app_is_service_mode')
     AND EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'app_tenant_ids') THEN
    FOREACH t IN ARRAY ARRAY['cost_splits', 'cost_split_shares']
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
