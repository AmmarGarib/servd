-- 20261105100000_bank_reconciliations — Bank Reconciliation Statements (owner, 2026-11-05).
-- One reconciliation per bank account per period (modules/reconciliation/brs.ts), section-F adjustments, marks on
-- book lines, and two columns on statement lines (under review, the import dedupe key). Nothing existing changes.
--
-- Runbook: if this migration fails on deploy, run
--   prisma migrate resolve --rolled-back 20261105100000_bank_reconciliations
-- in the api image before redeploying any image (P3009 blocks every image).
SET lock_timeout = '10s';

ALTER TABLE "bank_statement_lines" ADD COLUMN "underReview" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "bank_statement_lines" ADD COLUMN "dedupeKey" TEXT;

CREATE TABLE "bank_reconciliations" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "bankAccountId" TEXT NOT NULL,
  "accountCode" TEXT NOT NULL,
  "periodFrom" DATE NOT NULL,
  "periodTo" DATE NOT NULL,
  "periodKind" TEXT NOT NULL DEFAULT 'month',
  "bankClosingCents" BIGINT,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "snapshot" JSONB,
  "preparedById" TEXT NOT NULL,
  "preparedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "submittedById" TEXT,
  "submittedAt" TIMESTAMP(3),
  "approvedById" TEXT,
  "approvedAt" TIMESTAMP(3),
  "returnedById" TEXT,
  "returnedAt" TIMESTAMP(3),
  "returnNote" TEXT,
  "reopenedById" TEXT,
  "reopenedAt" TIMESTAMP(3),
  "reopenReason" TEXT,
  "reopenCount" INTEGER NOT NULL DEFAULT 0,
  "cancelledAt" TIMESTAMP(3),
  "cancelledById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "bank_reconciliations_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "bank_reconciliations_tenantId_status_idx" ON "bank_reconciliations"("tenantId", "status");
CREATE INDEX "bank_reconciliations_bankAccountId_periodTo_idx" ON "bank_reconciliations"("bankAccountId", "periodTo");

CREATE TABLE "bank_reconciliation_adjustments" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "reconciliationId" TEXT NOT NULL,
  "side" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "amountCents" BIGINT NOT NULL,
  "narration" TEXT NOT NULL,
  "reference" TEXT NOT NULL,
  "statementLineId" TEXT,
  "journalLineId" TEXT,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "removedAt" TIMESTAMP(3),
  "removedById" TEXT,
  "removeReason" TEXT,
  CONSTRAINT "bank_reconciliation_adjustments_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "bank_reconciliation_adjustments_reconciliationId_idx" ON "bank_reconciliation_adjustments"("reconciliationId");
CREATE INDEX "bank_reconciliation_adjustments_tenantId_idx" ON "bank_reconciliation_adjustments"("tenantId");

CREATE TABLE "bank_recon_book_marks" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "bankAccountId" TEXT NOT NULL,
  "journalLineId" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "note" TEXT NOT NULL,
  "reference" TEXT,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "bank_recon_book_marks_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "bank_recon_book_marks_journalLineId_key" ON "bank_recon_book_marks"("journalLineId");
CREATE INDEX "bank_recon_book_marks_tenantId_bankAccountId_idx" ON "bank_recon_book_marks"("tenantId", "bankAccountId");

-- ─── SQL-only objects (one statement per ';', no trailing comments)
CREATE INDEX "bank_statement_lines_dedupeKey_idx" ON "bank_statement_lines"("dedupeKey");
ALTER TABLE "bank_reconciliations" ADD CONSTRAINT "bank_reconciliations_status_chk" CHECK ("status" IN ('draft', 'submitted', 'approved', 'cancelled'));
ALTER TABLE "bank_reconciliations" ADD CONSTRAINT "bank_reconciliations_period_chk" CHECK ("periodFrom" <= "periodTo");
ALTER TABLE "bank_reconciliations" ADD CONSTRAINT "bank_reconciliations_kind_chk" CHECK ("periodKind" IN ('month', 'quarter', 'custom'));
ALTER TABLE "bank_reconciliation_adjustments" ADD CONSTRAINT "bank_reconciliation_adjustments_side_chk" CHECK ("side" IN ('bank', 'book'));
ALTER TABLE "bank_reconciliation_adjustments" ADD CONSTRAINT "bank_reconciliation_adjustments_kind_chk" CHECK ("kind" IN ('bank_error', 'book_error', 'duplicate', 'wrong_amount', 'other'));
ALTER TABLE "bank_reconciliation_adjustments" ADD CONSTRAINT "bank_reconciliation_adjustments_text_chk" CHECK (length(btrim("narration")) >= 10 AND length(btrim("reference")) >= 1);
ALTER TABLE "bank_recon_book_marks" ADD CONSTRAINT "bank_recon_book_marks_status_chk" CHECK ("status" IN ('under_review', 'cleared_prior'));

-- ─── Row-level security (the guarded pattern, as 20261027120000_reservation_overbook_approval).
DO $do$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'app_is_service_mode')
     AND EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'app_tenant_ids') THEN
    FOREACH t IN ARRAY ARRAY['bank_reconciliations', 'bank_reconciliation_adjustments', 'bank_recon_book_marks']
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
