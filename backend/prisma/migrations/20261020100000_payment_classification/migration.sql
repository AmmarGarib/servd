-- 20261020100000_payment_classification — Internal payment classification
-- (owner, 2026-10-20): a REPORTING DIMENSION on payments (Official /
-- Unofficial / Unclassified) plus the tax-deduction status and the reason for
-- non-deduction. One row per payment journal entry; no row = Unclassified.
--
-- HARD RULE: this table is a label. Nothing in the posting engine, the trial
-- balance, the tax returns or any statutory / payroll / WHT report reads it.
-- Stamped with the ENTRY's company (accounting/paymentsRegister.ts
-- classifyPaymentTx is the one writer).
--
-- Runbook: if this migration fails on deploy, run
--   prisma migrate resolve --rolled-back 20261020100000_payment_classification
-- in the api image before redeploying any image (P3009 blocks every image).
-- Rollback: an older image ignores the table (no money, no posting reads it).
SET lock_timeout = '10s';

CREATE TABLE "payment_classifications" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "journalEntryId" TEXT NOT NULL,
  "classification" TEXT NOT NULL,
  "taxStatus" TEXT,
  "nonDeductionReason" TEXT,
  "setById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "payment_classifications_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "payment_classifications_journalEntryId_key" ON "payment_classifications"("journalEntryId");
CREATE INDEX "payment_classifications_tenantId_classification_idx" ON "payment_classifications"("tenantId", "classification");

ALTER TABLE "payment_classifications" ADD CONSTRAINT "payment_classifications_journalEntryId_fkey"
  FOREIGN KEY ("journalEntryId") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── SQL-only objects (one statement per ';', no trailing comments)
ALTER TABLE "payment_classifications" ADD CONSTRAINT "payment_classifications_class_chk" CHECK ("classification" IN ('official', 'unofficial', 'unclassified'));
ALTER TABLE "payment_classifications" ADD CONSTRAINT "payment_classifications_tax_status_chk" CHECK ("taxStatus" IS NULL OR "taxStatus" IN ('deducted', 'not_deducted', 'not_applicable'));
ALTER TABLE "payment_classifications" ADD CONSTRAINT "payment_classifications_reason_chk" CHECK ("taxStatus" IS DISTINCT FROM 'not_deducted' OR char_length(btrim(COALESCE("nonDeductionReason", ''))) >= 10);

-- ─── Row-level security (the guarded wave-A/B pattern, as 20261017110000_sales_deposit_drop_shifts)
DO $do$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'app_is_service_mode')
     AND EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'app_tenant_ids') THEN
    FOREACH t IN ARRAY ARRAY['payment_classifications']
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
