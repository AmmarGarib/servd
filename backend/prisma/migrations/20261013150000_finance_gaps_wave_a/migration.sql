-- Finance gaps, wave A (2026-10-13): the columns the no-decision fixes need.
--   * which company bank account a supplier payment, receivable receipt,
--     wallet top-up or CapEx instalment used (bankAccountId);
--   * supplier credit notes / returns as SupplierBill rows of kind
--     'credit_note' + supplier_credit_applications; supplier payment void;
--   * receivable credit notes, customer income-tax withholding (whtCents)
--     and reversed receipts (bounced cheques);
--   * gift cards: how they were paid for, promotional kind, void disposition;
--   * OpexCategory.expenseAccountCode (replaces the name-keyword guess);
--   * sales_tax_payments: tax paid to an authority per company and period.
-- Additive only: new nullable columns, defaults, two new tables. Every new
-- company-level money column is BIGINT (BOOKS-06).
SET lock_timeout = '15s';

-- CreateEnum
CREATE TYPE "GiftCardKind" AS ENUM ('sold', 'promotional');

-- AlterTable
ALTER TABLE "gift_cards" ADD COLUMN     "bankAccountId" TEXT,
ADD COLUMN     "expiredAt" TIMESTAMP(3),
ADD COLUMN     "kind" "GiftCardKind" NOT NULL DEFAULT 'sold',
ADD COLUMN     "paymentMethod" TEXT,
ADD COLUMN     "voidDisposition" TEXT;

-- AlterTable
ALTER TABLE "supplier_bills" ADD COLUMN     "creditedCents" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'bill',
ADD COLUMN     "originalBillId" TEXT;

-- AlterTable
ALTER TABLE "supplier_bill_lines" ADD COLUMN     "returnQty" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "supplier_payments" ADD COLUMN     "bankAccountId" TEXT,
ADD COLUMN     "voidReason" TEXT,
ADD COLUMN     "voidedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "wallet_transactions" ADD COLUMN     "bankAccountId" TEXT;

-- AlterTable
ALTER TABLE "opex_categories" ADD COLUMN     "expenseAccountCode" TEXT;

-- AlterTable
ALTER TABLE "capex_payments" ADD COLUMN     "bankAccountId" TEXT;

-- AlterTable
ALTER TABLE "receivable_invoices" ADD COLUMN     "creditedCents" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'invoice',
ADD COLUMN     "originalInvoiceId" TEXT,
ADD COLUMN     "whtCents" BIGINT NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "receivable_payments" ADD COLUMN     "bankAccountId" TEXT,
ADD COLUMN     "reversedAt" TIMESTAMP(3),
ADD COLUMN     "reversedReason" TEXT;

-- CreateTable
CREATE TABLE "supplier_credit_applications" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "creditNoteId" TEXT NOT NULL,
    "billId" TEXT NOT NULL,
    "amountCents" BIGINT NOT NULL,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_credit_applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_tax_payments" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "authority" TEXT NOT NULL,
    "periodFrom" TIMESTAMP(3) NOT NULL,
    "periodTo" TIMESTAMP(3) NOT NULL,
    "outputSetOffCents" BIGINT NOT NULL DEFAULT 0,
    "inputSetOffCents" BIGINT NOT NULL DEFAULT 0,
    "paidCents" BIGINT NOT NULL DEFAULT 0,
    "paidAt" TIMESTAMP(3) NOT NULL,
    "bankAccountId" TEXT,
    "cprNumber" TEXT,
    "journalEntryId" TEXT,
    "linked" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_tax_payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "supplier_credit_applications_tenantId_idx" ON "supplier_credit_applications"("tenantId");

-- CreateIndex
CREATE INDEX "supplier_credit_applications_billId_idx" ON "supplier_credit_applications"("billId");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_credit_applications_creditNoteId_billId_key" ON "supplier_credit_applications"("creditNoteId", "billId");

-- CreateIndex
CREATE INDEX "sales_tax_payments_tenantId_paidAt_idx" ON "sales_tax_payments"("tenantId", "paidAt");

-- CreateIndex
CREATE UNIQUE INDEX "sales_tax_payments_tenantId_authority_periodFrom_key" ON "sales_tax_payments"("tenantId", "authority", "periodFrom");

-- CreateIndex
CREATE INDEX "gift_cards_tenantId_status_expiresAt_idx" ON "gift_cards"("tenantId", "status", "expiresAt");

-- CreateIndex
CREATE INDEX "supplier_bills_originalBillId_idx" ON "supplier_bills"("originalBillId");

-- CreateIndex
CREATE INDEX "supplier_payments_bankAccountId_idx" ON "supplier_payments"("bankAccountId");

-- CreateIndex
CREATE INDEX "receivable_invoices_originalInvoiceId_idx" ON "receivable_invoices"("originalInvoiceId");

-- AddForeignKey
ALTER TABLE "supplier_credit_applications" ADD CONSTRAINT "supplier_credit_applications_creditNoteId_fkey" FOREIGN KEY ("creditNoteId") REFERENCES "supplier_bills"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_credit_applications" ADD CONSTRAINT "supplier_credit_applications_billId_fkey" FOREIGN KEY ("billId") REFERENCES "supplier_bills"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Row-level security on the two new company tables (same pattern as the
-- rider app tables): service mode, or the caller's companies.
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'app_is_service_mode')
     AND EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'app_tenant_ids') THEN
    ALTER TABLE "supplier_credit_applications" ENABLE ROW LEVEL SECURITY;
    CREATE POLICY supplier_credit_applications_rls ON "supplier_credit_applications" FOR ALL
      USING (app_is_service_mode() OR "supplier_credit_applications"."tenantId" = ANY(app_tenant_ids()))
      WITH CHECK (app_is_service_mode() OR "supplier_credit_applications"."tenantId" = ANY(app_tenant_ids()));

    ALTER TABLE "sales_tax_payments" ENABLE ROW LEVEL SECURITY;
    CREATE POLICY sales_tax_payments_rls ON "sales_tax_payments" FOR ALL
      USING (app_is_service_mode() OR "sales_tax_payments"."tenantId" = ANY(app_tenant_ids()))
      WITH CHECK (app_is_service_mode() OR "sales_tax_payments"."tenantId" = ANY(app_tenant_ids()));
  END IF;
END
$do$;
