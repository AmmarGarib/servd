-- Finance wave B (2026-10-14): fixed assets v2, food cost on FIFO lots, tax
-- decisions (H8-H13), people (gratuity, statutory payables, close checklist,
-- fiscal year, inter-company), cash requests + petty cash in the ledger,
-- delivery code-only + emergency overrides + per-company strikes/bans,
-- on-account clients + bad debts + Raast void.
--
-- What it does, in order:
--   (a) new columns on existing tables — nullable, or NOT NULL with a constant
--       default (no table rewrite);
--   (b) new company tables (every one has tenantId, per-company uniques);
--   (c) their indexes and foreign keys;
--   (d) data backfills, each idempotent (guarded by its WHERE): fixed-asset
--       cost/in-service/CapEx link/brand+outlet/tags/disposal history, CapEx
--       project companies, chart names and the register-controlled codes,
--       Stackd's service vessel, receipt/waste companies, item categories,
--       recipe packaging sections, petty-cash companies and references, cash
--       request due dates, strike and ban companies (a legacy auto ban that
--       spans companies is split per company);
--   (e) SQL-only partial / expression unique indexes + one composite FK;
--   (f) CHECK constraints;
--   (g) row-level security on the new company tables.
-- Additive except: CashVoucher.boxId and CashVoucherAttachment.voucherId become
-- NULLABLE (their foreign keys keep ON DELETE RESTRICT), the petty_cash_movements
-- RLS policy is replaced, and backfills rewrite legacy values in place (asset
-- tags made unique per company, item categories normalised, packaging lines
-- moved to the recipe's Packaging section, cross-company asset brand/outlet
-- links cleared, multi-company auto bans split). Every new company-level money
-- column is BIGINT (BOOKS-06); per-ticket / per-unit / per-box money stays INT4.
-- Enum values this release needs were added by 20261014085900_finance_wave_b_enums
-- (its own transaction); nothing here uses them.
--
-- Locking: `prisma migrate deploy` runs this file in ONE transaction, before the
-- API boots (entrypoint.sh). ADD COLUMN with a constant default does not
-- rewrite; the backfills touch only matching rows; the CHECKs on orders and
-- order_items scan those tables once under the ALTER's lock. lock_timeout: if
-- anything else holds a lock on a touched table (a backup, a psql/BI session)
-- the statement fails after 15 s instead of hanging the deploy. SET (not SET
-- LOCAL) inside the migration's implicit transaction is reset when the session
-- ends.
--
-- IF THIS MIGRATION FAILS (P3009): Postgres rolls the whole file back, but
-- Prisma records it as FAILED in _prisma_migrations and every later
-- `prisma migrate deploy` — including the PREVIOUS api image's — exits with
-- P3009, so NEITHER image boots until it is resolved. BEFORE redeploying either
-- image, run in the api image:
--   docker compose run --rm api npx prisma migrate resolve --rolled-back 20261014090000_finance_wave_b
-- (or exec into the api container and run the same command), fix the cause
-- (lock holder, a CHECK an unexpected legacy value fails — the error names the
-- constraint), then deploy again. Do NOT make entrypoint.sh auto-resolve. The
-- enum migration 20261014085900 is harmless to keep: unused enum values.
--
-- Rollback after SUCCESS: redeploying the previous images is safe for reads —
-- they ignore the new columns and tables — but the old cash-voucher code
-- assumes boxId is set, so do not roll back once cash requests are in use.
SET lock_timeout = '15s';

-- ═════════════════════════════════════════════════════════════════════════════
-- (a) Columns on existing tables
-- ═════════════════════════════════════════════════════════════════════════════

-- AlterTable
ALTER TABLE "concepts" ADD COLUMN     "serviceVessel" TEXT NOT NULL DEFAULT 'plate';

-- AlterTable
ALTER TABLE "gift_cards" ADD COLUMN     "breakageAt" TIMESTAMP(3),
ADD COLUMN     "breakageCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "breakagePendingAt" TIMESTAMP(3),
ADD COLUMN     "breakagePendingReason" TEXT;

-- AlterTable
ALTER TABLE "customer_strikes" ADD COLUMN     "tenantId" TEXT;

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "deliveryFeeCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "deliveryFeeTaxCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "handoverRerouteAttempts" INTEGER,
ADD COLUMN     "handoverRerouteRiderId" TEXT,
ADD COLUMN     "handoverReroutedAt" TIMESTAMP(3),
ADD COLUMN     "returnCause" TEXT,
ADD COLUMN     "returnedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "order_items" ADD COLUMN     "boxGiven" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "boxGivenAt" TIMESTAMP(3),
ADD COLUMN     "boxGivenById" TEXT,
ADD COLUMN     "serviceVessel" TEXT;

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "codRiderDebtAt" TIMESTAMP(3),
ADD COLUMN     "codRiderDebtById" TEXT,
ADD COLUMN     "codRiderDebtEntryId" TEXT,
ADD COLUMN     "codRiderDebtTransferId" TEXT;

-- AlterTable
ALTER TABLE "inventory_items" ADD COLUMN     "issueOnReceipt" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "waste_logs" ADD COLUMN     "conceptId" TEXT,
ADD COLUMN     "locationId" TEXT,
ADD COLUMN     "orderItemId" TEXT,
ADD COLUMN     "tenantId" TEXT;

-- AlterTable
ALTER TABLE "suppliers" ADD COLUMN     "defaultTaxAuthority" TEXT,
ADD COLUMN     "defaultWhtSection" TEXT,
ADD COLUMN     "filerStatus" TEXT NOT NULL DEFAULT 'unknown',
ADD COLUMN     "systemKind" TEXT,
ADD COLUMN     "whtExemptCertNo" TEXT,
ADD COLUMN     "whtExemptUntil" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "recipes" ADD COLUMN     "modifierId" TEXT;

-- AlterTable
ALTER TABLE "recipe_ingredients" ADD COLUMN     "section" TEXT NOT NULL DEFAULT 'ingredients';

-- AlterTable
ALTER TABLE "supplier_bills" ADD COLUMN     "taxAuthority" TEXT NOT NULL DEFAULT 'fbr',
ADD COLUMN     "whtRateBps" INTEGER,
ADD COLUMN     "whtSection" TEXT;

-- AlterTable
ALTER TABLE "supplier_bill_lines" ADD COLUMN     "expenseAccountCode" TEXT,
ADD COLUMN     "receiptLineId" TEXT;

-- AlterTable
ALTER TABLE "accounts" ADD COLUMN     "controlledBy" TEXT,
ADD COLUMN     "counterpartyTenantId" TEXT;

-- AlterTable
ALTER TABLE "tax_invoices" ADD COLUMN     "deliveryFeeCents" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "period_locks" ADD COLUMN     "overrideReason" TEXT,
ADD COLUMN     "overrides" JSONB;

-- AlterTable
ALTER TABLE "rider_job_events" ADD COLUMN     "actorId" TEXT;

-- AlterTable
ALTER TABLE "order_complaints" ADD COLUMN     "banId" TEXT,
ADD COLUMN     "contactPhone" TEXT,
ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'complaint';

-- AlterTable
ALTER TABLE "operations_configs" ADD COLUMN     "assetTagPrefix" TEXT NOT NULL DEFAULT 'FA-',
ADD COLUMN     "capexAdvanceOverdueDays" INTEGER NOT NULL DEFAULT 45,
ADD COLUMN     "capexUncapitalisedAlertDays" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "cardSettlement" JSONB,
ADD COLUMN     "cashAdvanceSettleDays" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "deferredTaxRateBp" INTEGER NOT NULL DEFAULT 2900,
ADD COLUMN     "withholdingRates" JSONB;

-- AlterTable
ALTER TABLE "capex_projects" ADD COLUMN     "isStanding" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "capex_lines" ADD COLUMN     "inputTaxAuthority" TEXT,
ADD COLUMN     "inputTaxCents" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "supplierId" TEXT,
ADD COLUMN     "treatment" TEXT,
ADD COLUMN     "whtSection" TEXT;

-- AlterTable
ALTER TABLE "opex_lines" ADD COLUMN     "inputTaxAuthority" TEXT,
ADD COLUMN     "supplierId" TEXT,
ADD COLUMN     "whtSection" TEXT;

-- AlterTable
ALTER TABLE "opex_payments" ADD COLUMN     "coversFrom" TEXT,
ADD COLUMN     "coversMonths" INTEGER,
ADD COLUMN     "filerStatus" TEXT,
ADD COLUMN     "inputTaxAuthority" TEXT,
ADD COLUMN     "inputTaxCents" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "treatment" TEXT NOT NULL DEFAULT 'expense',
ADD COLUMN     "whtCents" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "whtOverrideReason" TEXT,
ADD COLUMN     "whtRateBps" INTEGER,
ADD COLUMN     "whtSection" TEXT;

-- AlterTable
ALTER TABLE "capex_payments" ADD COLUMN     "coversFrom" TEXT,
ADD COLUMN     "coversMonths" INTEGER,
ADD COLUMN     "depositForfeitedCents" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "depositReturnBankAccountId" TEXT,
ADD COLUMN     "depositReturnMethod" TEXT,
ADD COLUMN     "depositReturnedAt" TIMESTAMP(3),
ADD COLUMN     "depositReturnedCents" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "filerStatus" TEXT,
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'finance',
ADD COLUMN     "whtCents" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "whtOverrideReason" TEXT,
ADD COLUMN     "whtRateBps" INTEGER,
ADD COLUMN     "whtSection" TEXT;

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "fiscalYearEndMonth" INTEGER NOT NULL DEFAULT 6;

-- AlterTable
ALTER TABLE "goods_receipts" ADD COLUMN     "locationId" TEXT,
ADD COLUMN     "settledAccountCode" TEXT,
ADD COLUMN     "settledById" TEXT,
ADD COLUMN     "settledByType" TEXT,
ADD COLUMN     "tenantId" TEXT;

-- AlterTable
ALTER TABLE "goods_receipt_lines" ADD COLUMN     "billedQty" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "lotUnitCostCents" INTEGER,
ADD COLUMN     "writeOffEntryId" TEXT,
ADD COLUMN     "writeOffReason" TEXT,
ADD COLUMN     "writeOffRequestedAt" TIMESTAMP(3),
ADD COLUMN     "writeOffRequestedById" TEXT,
ADD COLUMN     "writtenOffAt" TIMESTAMP(3),
ADD COLUMN     "writtenOffById" TEXT;

-- AlterTable
ALTER TABLE "prep_batches" ADD COLUMN     "drawValueCents" BIGINT,
ADD COLUMN     "locationId" TEXT;

-- AlterTable
ALTER TABLE "physical_counts" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'spot',
ADD COLUMN     "locationId" TEXT;

-- AlterTable
ALTER TABLE "physical_count_lines" ADD COLUMN     "unitCostCents" INTEGER,
ADD COLUMN     "valueCents" BIGINT;

-- AlterTable
ALTER TABLE "petty_cash_movements" ADD COLUMN     "accountCode" TEXT,
ADD COLUMN     "bankAccountId" TEXT,
ADD COLUMN     "cashMovementId" TEXT,
ADD COLUMN     "cashVoucherId" TEXT,
ADD COLUMN     "conceptId" TEXT,
ADD COLUMN     "journalEntryId" TEXT,
ADD COLUMN     "shiftId" TEXT,
ADD COLUMN     "source" TEXT,
ADD COLUMN     "tenantId" TEXT,
ADD COLUMN     "transferRef" TEXT;

-- AlterTable
ALTER TABLE "fixed_assets" ADD COLUMN     "capexLineId" TEXT,
ADD COLUMN     "capexLineUnit" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "carriedAccumulatedCents" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "disposalKind" TEXT,
ADD COLUMN     "disposalReason" TEXT,
ADD COLUMN     "documentUrls" JSONB,
ADD COLUMN     "inServiceAt" TIMESTAMP(3),
ADD COLUMN     "inputTaxCents" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "inputTaxCode" TEXT,
ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'individual',
ADD COLUMN     "leaseEndsAt" TIMESTAMP(3),
ADD COLUMN     "method" TEXT NOT NULL DEFAULT 'straight_line',
ADD COLUMN     "originalCostCents" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "originalQuantity" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "photoUrls" JSONB,
ADD COLUMN     "poolId" TEXT,
ADD COLUMN     "quantity" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "splitFromAssetId" TEXT,
ADD COLUMN     "supplierId" TEXT,
ADD COLUMN     "voidReason" TEXT,
ADD COLUMN     "voidedAt" TIMESTAMP(3),
ADD COLUMN     "warrantyUntil" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "fixed_asset_depreciation" ADD COLUMN     "accumCode" TEXT NOT NULL DEFAULT '1590',
ADD COLUMN     "conceptId" TEXT,
ADD COLUMN     "locationId" TEXT,
ADD COLUMN     "postedPeriod" TEXT,
ADD COLUMN     "reversedAt" TIMESTAMP(3),
ADD COLUMN     "revision" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "receivable_invoices" ADD COLUMN     "customerAccountId" TEXT,
ADD COLUMN     "periodFrom" TIMESTAMP(3),
ADD COLUMN     "periodTo" TIMESTAMP(3),
ADD COLUMN     "writtenOffCents" BIGINT NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "receivable_payments" ADD COLUMN     "taxAuthority" TEXT,
ADD COLUMN     "writeOffId" TEXT;

-- AlterTable
ALTER TABLE "sales_tax_payments" ADD COLUMN     "customerWithheldSetOffCents" BIGINT NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "raast_receipts" ADD COLUMN     "voidReason" TEXT,
ADD COLUMN     "voidRequestReason" TEXT,
ADD COLUMN     "voidRequestedAt" TIMESTAMP(3),
ADD COLUMN     "voidRequestedById" TEXT,
ADD COLUMN     "voidedAt" TIMESTAMP(3),
ADD COLUMN     "voidedById" TEXT;

-- AlterTable
ALTER TABLE "cash_vouchers" ADD COLUMN     "conversionNote" TEXT,
ADD COLUMN     "convertedAt" TIMESTAMP(3),
ADD COLUMN     "convertedById" TEXT,
ADD COLUMN     "convertedCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "convertedTo" TEXT,
ADD COLUMN     "dueBy" TIMESTAMP(3),
ADD COLUMN     "hrLoanRecordId" TEXT,
ADD COLUMN     "overdueFlaggedAt" TIMESTAMP(3),
ADD COLUMN     "returnedCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "settledAt" TIMESTAMP(3),
ADD COLUMN     "settledCents" INTEGER NOT NULL DEFAULT 0,
ALTER COLUMN "boxId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "cash_voucher_attachments" ADD COLUMN     "boxId" TEXT,
ADD COLUMN     "movementId" TEXT,
ADD COLUMN     "settlementId" TEXT,
ALTER COLUMN "voucherId" DROP NOT NULL;

-- ═════════════════════════════════════════════════════════════════════════════
-- (b) New tables
-- ═════════════════════════════════════════════════════════════════════════════

-- CreateTable
CREATE TABLE "fleet_rates" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "clientTenantId" TEXT NOT NULL,
    "agreementId" TEXT NOT NULL,
    "fromPeriod" TEXT NOT NULL,
    "ratePerTripCents" INTEGER NOT NULL,
    "setById" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fleet_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intercompany_transfers" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "counterpartyTenantId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "sourceRef" TEXT,
    "period" TEXT,
    "amountCents" BIGINT NOT NULL,
    "entryDate" TIMESTAMP(3) NOT NULL,
    "debtorAccountCode" TEXT,
    "creditorAccountCode" TEXT,
    "conceptSplit" JSONB,
    "method" TEXT,
    "debtorBankAccountId" TEXT,
    "creditorBankAccountId" TEXT,
    "bankReference" TEXT,
    "memo" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'submitted',
    "preparedById" TEXT NOT NULL,
    "preparedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "selfApproved" BOOLEAN NOT NULL DEFAULT false,
    "debtorEntryId" TEXT,
    "creditorEntryId" TEXT,
    "reversedById" TEXT,
    "reversedAt" TIMESTAMP(3),
    "reversalReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "intercompany_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_lots" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "inventoryItemId" TEXT NOT NULL,
    "locationId" TEXT,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "receiptLineId" TEXT,
    "costClass" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "qtyIn" DOUBLE PRECISION NOT NULL,
    "remainingQty" DOUBLE PRECISION NOT NULL,
    "unitCostCents" INTEGER NOT NULL,
    "valueInCents" BIGINT NOT NULL,
    "remainingValueCents" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_lots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_movements" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "inventoryItemId" TEXT NOT NULL,
    "lotId" TEXT,
    "lotKey" TEXT NOT NULL DEFAULT '',
    "kind" TEXT NOT NULL,
    "qty" DOUBLE PRECISION NOT NULL,
    "valueCents" BIGINT NOT NULL,
    "unitCostCents" INTEGER NOT NULL,
    "costClass" TEXT NOT NULL,
    "theoreticalQty" DOUBLE PRECISION,
    "shortfallQty" DOUBLE PRECISION,
    "shortfallValueCents" BIGINT,
    "settlesMovementId" TEXT,
    "conceptId" TEXT,
    "brandShares" JSONB,
    "locationId" TEXT,
    "orderId" TEXT,
    "orderItemId" TEXT,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "grni_matches" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "billId" TEXT NOT NULL,
    "billLineId" TEXT NOT NULL,
    "receiptLineId" TEXT,
    "poLineId" TEXT,
    "qty" DOUBLE PRECISION NOT NULL,
    "receiptUnitCostCents" INTEGER,
    "billedUnitCostCents" INTEGER NOT NULL,
    "grniCents" BIGINT NOT NULL,
    "priceDiffCents" BIGINT NOT NULL DEFAULT 0,
    "absorbedCents" BIGINT NOT NULL DEFAULT 0,
    "usedCents" BIGINT NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'live',
    "settledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "grni_matches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fixed_asset_classes" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "costAccountCode" TEXT NOT NULL,
    "accumAccountCode" TEXT,
    "depreciable" BOOLEAN NOT NULL DEFAULT true,
    "pooled" BOOLEAN NOT NULL DEFAULT false,
    "defaultLifeMonths" INTEGER,
    "taxRateBp" INTEGER NOT NULL DEFAULT 0,
    "taxInitialAllowanceBp" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fixed_asset_classes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fixed_asset_pools" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "conceptId" TEXT,
    "classKey" TEXT NOT NULL,
    "typeKey" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fixed_asset_pools_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fixed_asset_events" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "assetId" TEXT,
    "poolId" TEXT,
    "capexLineId" TEXT,
    "parentEventId" TEXT,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "effectiveDate" TIMESTAMP(3) NOT NULL,
    "payload" JSONB NOT NULL,
    "amountCents" BIGINT,
    "costOutCents" BIGINT,
    "accumOutCents" BIGINT,
    "reason" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "postedAt" TIMESTAMP(3),
    "journalEntryId" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fixed_asset_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fixed_asset_tax_years" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "taxYear" INTEGER NOT NULL,
    "rateBp" INTEGER NOT NULL,
    "openingWdvCents" BIGINT NOT NULL,
    "additionsCents" BIGINT NOT NULL,
    "initialAllowanceCents" BIGINT NOT NULL,
    "depreciationCents" BIGINT NOT NULL,
    "disposalProceedsCents" BIGINT NOT NULL,
    "closingWdvCents" BIGINT NOT NULL,
    "frozenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "frozenById" TEXT NOT NULL,

    CONSTRAINT "fixed_asset_tax_years_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fixed_asset_runs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "throughPeriod" TEXT NOT NULL,
    "triggeredBy" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "chargedCount" INTEGER NOT NULL DEFAULT 0,
    "chargedCents" BIGINT NOT NULL DEFAULT 0,
    "lateCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,

    CONSTRAINT "fixed_asset_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prepaid_releases" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "amountCents" BIGINT NOT NULL,
    "postedPeriod" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "reversedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prepaid_releases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "card_settlements" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "unit" TEXT NOT NULL DEFAULT 'company',
    "bankAccountId" TEXT NOT NULL,
    "statementLineId" TEXT NOT NULL,
    "journalEntryId" TEXT,
    "grossCents" BIGINT NOT NULL,
    "feeCents" BIGINT NOT NULL,
    "feeTaxCents" BIGINT NOT NULL DEFAULT 0,
    "netCents" BIGINT NOT NULL,
    "dayFrom" TEXT NOT NULL,
    "dayTo" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "card_settlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "card_settlement_days" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "settlementId" TEXT NOT NULL,
    "unit" TEXT NOT NULL DEFAULT 'company',
    "day" TEXT NOT NULL,
    "grossCents" BIGINT NOT NULL,

    CONSTRAINT "card_settlement_days_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_accounts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "legalName" TEXT NOT NULL,
    "tradeName" TEXT,
    "ntn" TEXT,
    "strn" TEXT,
    "cnic" TEXT,
    "address" TEXT,
    "contactName" TEXT,
    "contactPhone" TEXT,
    "contactEmail" TEXT,
    "creditLimitCents" BIGINT NOT NULL DEFAULT 0,
    "requestedCreditLimitCents" BIGINT,
    "limitRequestedById" TEXT,
    "limitRequestedAt" TIMESTAMP(3),
    "termsDays" INTEGER NOT NULL DEFAULT 30,
    "overdueGraceDays" INTEGER NOT NULL DEFAULT 7,
    "requiresReference" BOOLEAN NOT NULL DEFAULT false,
    "conceptIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'pending',
    "statusReason" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_account_cards" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenHint" TEXT NOT NULL,
    "issuedById" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,
    "revokedReason" TEXT,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "customer_account_cards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_account_charges" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "cardId" TEXT,
    "orderId" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "conceptId" TEXT NOT NULL,
    "shiftId" TEXT,
    "amountCents" INTEGER NOT NULL,
    "taxCents" INTEGER NOT NULL DEFAULT 0,
    "refundedCents" INTEGER NOT NULL DEFAULT 0,
    "reference" TEXT,
    "chargedById" TEXT NOT NULL,
    "chargedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "statementInvoiceId" TEXT,

    CONSTRAINT "customer_account_charges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receivable_write_offs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "amountCents" BIGINT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'requested',
    "requestedById" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "journalEntryId" TEXT,
    "recoveredCents" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "receivable_write_offs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receivable_write_off_attachments" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "writeOffId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "receivable_write_off_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cash_voucher_settlements" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "voucherId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "totalCents" INTEGER NOT NULL,
    "note" TEXT,
    "submittedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cash_voucher_settlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "petty_cash_spend_lines" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "movementId" TEXT,
    "settlementId" TEXT,
    "kind" TEXT NOT NULL,
    "categoryKey" TEXT,
    "accountCode" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "conceptId" TEXT,
    "description" TEXT NOT NULL,
    "inventoryItemId" TEXT,
    "quantity" DOUBLE PRECISION,
    "unit" TEXT,
    "locationId" TEXT,
    "receiptLineId" TEXT,
    "capexLineId" TEXT,
    "capexPaymentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "petty_cash_spend_lines_pkey" PRIMARY KEY ("id")
);

-- ═════════════════════════════════════════════════════════════════════════════
-- (c) Indexes and foreign keys (the fixed_assets brand/outlet FKs and the
--     asset-tag unique are in (d), after the backfills they depend on)
-- ═════════════════════════════════════════════════════════════════════════════

-- CreateIndex
CREATE INDEX "fleet_rates_tenantId_idx" ON "fleet_rates"("tenantId");

-- CreateIndex
CREATE INDEX "fleet_rates_clientTenantId_idx" ON "fleet_rates"("clientTenantId");

-- CreateIndex
CREATE UNIQUE INDEX "fleet_rates_tenantId_agreementId_fromPeriod_key" ON "fleet_rates"("tenantId", "agreementId", "fromPeriod");

-- CreateIndex
CREATE UNIQUE INDEX "intercompany_transfers_debtorEntryId_key" ON "intercompany_transfers"("debtorEntryId");

-- CreateIndex
CREATE UNIQUE INDEX "intercompany_transfers_creditorEntryId_key" ON "intercompany_transfers"("creditorEntryId");

-- CreateIndex
CREATE INDEX "intercompany_transfers_tenantId_status_entryDate_idx" ON "intercompany_transfers"("tenantId", "status", "entryDate");

-- CreateIndex
CREATE INDEX "intercompany_transfers_counterpartyTenantId_status_entryDat_idx" ON "intercompany_transfers"("counterpartyTenantId", "status", "entryDate");

-- CreateIndex
CREATE UNIQUE INDEX "intercompany_transfers_tenantId_counterpartyTenantId_source_key" ON "intercompany_transfers"("tenantId", "counterpartyTenantId", "sourceRef");

-- CreateIndex
CREATE INDEX "stock_lots_tenantId_inventoryItemId_receivedAt_idx" ON "stock_lots"("tenantId", "inventoryItemId", "receivedAt");

-- CreateIndex
CREATE INDEX "stock_lots_receiptLineId_idx" ON "stock_lots"("receiptLineId");

-- CreateIndex
CREATE UNIQUE INDEX "stock_lots_tenantId_sourceType_sourceId_inventoryItemId_key" ON "stock_lots"("tenantId", "sourceType", "sourceId", "inventoryItemId");

-- CreateIndex
CREATE INDEX "stock_movements_tenantId_occurredAt_idx" ON "stock_movements"("tenantId", "occurredAt");

-- CreateIndex
CREATE INDEX "stock_movements_tenantId_inventoryItemId_occurredAt_idx" ON "stock_movements"("tenantId", "inventoryItemId", "occurredAt");

-- CreateIndex
CREATE INDEX "stock_movements_orderId_idx" ON "stock_movements"("orderId");

-- CreateIndex
CREATE INDEX "stock_movements_orderItemId_idx" ON "stock_movements"("orderItemId");

-- CreateIndex
CREATE INDEX "stock_movements_lotId_idx" ON "stock_movements"("lotId");

-- CreateIndex
CREATE INDEX "stock_movements_settlesMovementId_idx" ON "stock_movements"("settlesMovementId");

-- CreateIndex
CREATE UNIQUE INDEX "stock_movements_tenantId_sourceType_sourceId_inventoryItemI_key" ON "stock_movements"("tenantId", "sourceType", "sourceId", "inventoryItemId", "kind", "lotKey");

-- CreateIndex
CREATE INDEX "grni_matches_tenantId_status_idx" ON "grni_matches"("tenantId", "status");

-- CreateIndex
CREATE INDEX "grni_matches_billId_idx" ON "grni_matches"("billId");

-- CreateIndex
CREATE INDEX "grni_matches_billLineId_idx" ON "grni_matches"("billLineId");

-- CreateIndex
CREATE INDEX "grni_matches_receiptLineId_idx" ON "grni_matches"("receiptLineId");

-- CreateIndex
CREATE INDEX "grni_matches_poLineId_status_idx" ON "grni_matches"("poLineId", "status");

-- CreateIndex
CREATE INDEX "fixed_asset_classes_tenantId_idx" ON "fixed_asset_classes"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "fixed_asset_classes_tenantId_key_key" ON "fixed_asset_classes"("tenantId", "key");

-- CreateIndex
CREATE INDEX "fixed_asset_pools_tenantId_locationId_idx" ON "fixed_asset_pools"("tenantId", "locationId");

-- CreateIndex
CREATE INDEX "fixed_asset_events_tenantId_status_idx" ON "fixed_asset_events"("tenantId", "status");

-- CreateIndex
CREATE INDEX "fixed_asset_events_assetId_effectiveDate_idx" ON "fixed_asset_events"("assetId", "effectiveDate");

-- CreateIndex
CREATE INDEX "fixed_asset_events_poolId_idx" ON "fixed_asset_events"("poolId");

-- CreateIndex
CREATE INDEX "fixed_asset_events_capexLineId_idx" ON "fixed_asset_events"("capexLineId");

-- CreateIndex
CREATE INDEX "fixed_asset_events_parentEventId_idx" ON "fixed_asset_events"("parentEventId");

-- CreateIndex
CREATE INDEX "fixed_asset_tax_years_tenantId_taxYear_idx" ON "fixed_asset_tax_years"("tenantId", "taxYear");

-- CreateIndex
CREATE UNIQUE INDEX "fixed_asset_tax_years_tenantId_assetId_taxYear_key" ON "fixed_asset_tax_years"("tenantId", "assetId", "taxYear");

-- CreateIndex
CREATE INDEX "fixed_asset_runs_tenantId_startedAt_idx" ON "fixed_asset_runs"("tenantId", "startedAt");

-- CreateIndex
CREATE INDEX "prepaid_releases_tenantId_period_idx" ON "prepaid_releases"("tenantId", "period");

-- CreateIndex
CREATE UNIQUE INDEX "prepaid_releases_tenantId_sourceType_sourceId_period_key" ON "prepaid_releases"("tenantId", "sourceType", "sourceId", "period");

-- CreateIndex
CREATE INDEX "card_settlements_tenantId_dayTo_idx" ON "card_settlements"("tenantId", "dayTo");

-- CreateIndex
CREATE UNIQUE INDEX "card_settlements_tenantId_statementLineId_key" ON "card_settlements"("tenantId", "statementLineId");

-- CreateIndex
CREATE INDEX "card_settlement_days_settlementId_idx" ON "card_settlement_days"("settlementId");

-- CreateIndex
CREATE UNIQUE INDEX "card_settlement_days_tenantId_unit_day_key" ON "card_settlement_days"("tenantId", "unit", "day");

-- CreateIndex
CREATE INDEX "customer_accounts_tenantId_status_idx" ON "customer_accounts"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "customer_accounts_tenantId_number_key" ON "customer_accounts"("tenantId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "customer_accounts_tenantId_legalName_key" ON "customer_accounts"("tenantId", "legalName");

-- CreateIndex
CREATE INDEX "customer_account_cards_tenantId_accountId_idx" ON "customer_account_cards"("tenantId", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "customer_account_cards_tenantId_tokenHash_key" ON "customer_account_cards"("tenantId", "tokenHash");

-- CreateIndex
CREATE INDEX "customer_account_charges_tenantId_accountId_statementInvoic_idx" ON "customer_account_charges"("tenantId", "accountId", "statementInvoiceId");

-- CreateIndex
CREATE INDEX "customer_account_charges_statementInvoiceId_idx" ON "customer_account_charges"("statementInvoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "customer_account_charges_tenantId_orderId_key" ON "customer_account_charges"("tenantId", "orderId");

-- CreateIndex
CREATE UNIQUE INDEX "customer_account_charges_tenantId_paymentId_key" ON "customer_account_charges"("tenantId", "paymentId");

-- CreateIndex
CREATE INDEX "receivable_write_offs_tenantId_status_idx" ON "receivable_write_offs"("tenantId", "status");

-- CreateIndex
CREATE INDEX "receivable_write_offs_invoiceId_idx" ON "receivable_write_offs"("invoiceId");

-- CreateIndex
CREATE INDEX "receivable_write_off_attachments_writeOffId_idx" ON "receivable_write_off_attachments"("writeOffId");

-- CreateIndex
CREATE INDEX "cash_voucher_settlements_tenantId_createdAt_idx" ON "cash_voucher_settlements"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "cash_voucher_settlements_tenantId_voucherId_seq_key" ON "cash_voucher_settlements"("tenantId", "voucherId", "seq");

-- CreateIndex
CREATE INDEX "petty_cash_spend_lines_tenantId_createdAt_idx" ON "petty_cash_spend_lines"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "petty_cash_spend_lines_movementId_idx" ON "petty_cash_spend_lines"("movementId");

-- CreateIndex
CREATE INDEX "petty_cash_spend_lines_settlementId_idx" ON "petty_cash_spend_lines"("settlementId");

-- CreateIndex
CREATE UNIQUE INDEX "petty_cash_spend_lines_tenantId_capexPaymentId_key" ON "petty_cash_spend_lines"("tenantId", "capexPaymentId");

-- CreateIndex
CREATE INDEX "customer_strikes_tenantId_customerId_idx" ON "customer_strikes"("tenantId", "customerId");

-- CreateIndex
CREATE INDEX "waste_logs_tenantId_recordedAt_idx" ON "waste_logs"("tenantId", "recordedAt");

-- CreateIndex
CREATE INDEX "waste_logs_orderItemId_idx" ON "waste_logs"("orderItemId");

-- CreateIndex
CREATE UNIQUE INDEX "suppliers_tenantId_systemKind_key" ON "suppliers"("tenantId", "systemKind");

-- CreateIndex
CREATE UNIQUE INDEX "recipes_modifierId_key" ON "recipes"("modifierId");

-- CreateIndex
CREATE INDEX "supplier_bill_lines_receiptLineId_idx" ON "supplier_bill_lines"("receiptLineId");

-- CreateIndex
CREATE INDEX "accounts_tenantId_controlledBy_idx" ON "accounts"("tenantId", "controlledBy");

-- CreateIndex
CREATE INDEX "order_complaints_banId_idx" ON "order_complaints"("banId");

-- CreateIndex
CREATE INDEX "order_complaints_kind_status_idx" ON "order_complaints"("kind", "status");

-- CreateIndex
CREATE INDEX "capex_lines_supplierId_idx" ON "capex_lines"("supplierId");

-- CreateIndex
CREATE INDEX "opex_lines_supplierId_idx" ON "opex_lines"("supplierId");

-- CreateIndex
CREATE INDEX "goods_receipts_tenantId_receivedAt_idx" ON "goods_receipts"("tenantId", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "goods_receipts_tenantId_settledByType_settledById_key" ON "goods_receipts"("tenantId", "settledByType", "settledById");

-- CreateIndex
CREATE INDEX "physical_counts_tenantId_kind_countedAt_idx" ON "physical_counts"("tenantId", "kind", "countedAt");

-- CreateIndex
CREATE INDEX "petty_cash_movements_tenantId_createdAt_idx" ON "petty_cash_movements"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "petty_cash_movements_cashVoucherId_idx" ON "petty_cash_movements"("cashVoucherId");

-- CreateIndex
CREATE INDEX "petty_cash_movements_transferRef_idx" ON "petty_cash_movements"("transferRef");

-- CreateIndex
CREATE UNIQUE INDEX "petty_cash_movements_tenantId_cashMovementId_key" ON "petty_cash_movements"("tenantId", "cashMovementId");

-- CreateIndex
CREATE INDEX "fixed_assets_tenantId_category_idx" ON "fixed_assets"("tenantId", "category");

-- CreateIndex
CREATE INDEX "fixed_assets_tenantId_conceptId_idx" ON "fixed_assets"("tenantId", "conceptId");

-- CreateIndex
CREATE INDEX "fixed_assets_tenantId_locationId_idx" ON "fixed_assets"("tenantId", "locationId");

-- CreateIndex
CREATE INDEX "fixed_assets_poolId_idx" ON "fixed_assets"("poolId");

-- CreateIndex
CREATE INDEX "fixed_assets_capexLineId_idx" ON "fixed_assets"("capexLineId");

-- CreateIndex
CREATE INDEX "receivable_invoices_tenantId_customerAccountId_status_idx" ON "receivable_invoices"("tenantId", "customerAccountId", "status");

-- CreateIndex
CREATE INDEX "cash_vouchers_tenantId_status_dueBy_idx" ON "cash_vouchers"("tenantId", "status", "dueBy");

-- CreateIndex
CREATE UNIQUE INDEX "cash_vouchers_tenantId_hrLoanRecordId_key" ON "cash_vouchers"("tenantId", "hrLoanRecordId");

-- CreateIndex
CREATE INDEX "cash_voucher_attachments_settlementId_idx" ON "cash_voucher_attachments"("settlementId");

-- CreateIndex
CREATE INDEX "cash_voucher_attachments_movementId_idx" ON "cash_voucher_attachments"("movementId");

-- CreateIndex
CREATE INDEX "cash_voucher_attachments_boxId_idx" ON "cash_voucher_attachments"("boxId");

-- AddForeignKey
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_modifierId_fkey" FOREIGN KEY ("modifierId") REFERENCES "modifiers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_bill_lines" ADD CONSTRAINT "supplier_bill_lines_receiptLineId_fkey" FOREIGN KEY ("receiptLineId") REFERENCES "goods_receipt_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_counterpartyTenantId_fkey" FOREIGN KEY ("counterpartyTenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fleet_rates" ADD CONSTRAINT "fleet_rates_agreementId_fkey" FOREIGN KEY ("agreementId") REFERENCES "fleet_agreements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fleet_rates" ADD CONSTRAINT "fleet_rates_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fleet_rates" ADD CONSTRAINT "fleet_rates_clientTenantId_fkey" FOREIGN KEY ("clientTenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intercompany_transfers" ADD CONSTRAINT "intercompany_transfers_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intercompany_transfers" ADD CONSTRAINT "intercompany_transfers_counterpartyTenantId_fkey" FOREIGN KEY ("counterpartyTenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_complaints" ADD CONSTRAINT "order_complaints_banId_fkey" FOREIGN KEY ("banId") REFERENCES "customer_bans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "capex_lines" ADD CONSTRAINT "capex_lines_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opex_lines" ADD CONSTRAINT "opex_lines_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_lots" ADD CONSTRAINT "stock_lots_inventoryItemId_fkey" FOREIGN KEY ("inventoryItemId") REFERENCES "inventory_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_lots" ADD CONSTRAINT "stock_lots_receiptLineId_fkey" FOREIGN KEY ("receiptLineId") REFERENCES "goods_receipt_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "stock_lots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grni_matches" ADD CONSTRAINT "grni_matches_billId_fkey" FOREIGN KEY ("billId") REFERENCES "supplier_bills"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grni_matches" ADD CONSTRAINT "grni_matches_billLineId_fkey" FOREIGN KEY ("billLineId") REFERENCES "supplier_bill_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grni_matches" ADD CONSTRAINT "grni_matches_receiptLineId_fkey" FOREIGN KEY ("receiptLineId") REFERENCES "goods_receipt_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_poolId_fkey" FOREIGN KEY ("poolId") REFERENCES "fixed_asset_pools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_capexLineId_fkey" FOREIGN KEY ("capexLineId") REFERENCES "capex_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fixed_asset_pools" ADD CONSTRAINT "fixed_asset_pools_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fixed_asset_pools" ADD CONSTRAINT "fixed_asset_pools_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "concepts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fixed_asset_events" ADD CONSTRAINT "fixed_asset_events_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "fixed_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fixed_asset_events" ADD CONSTRAINT "fixed_asset_events_poolId_fkey" FOREIGN KEY ("poolId") REFERENCES "fixed_asset_pools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fixed_asset_tax_years" ADD CONSTRAINT "fixed_asset_tax_years_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "fixed_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "card_settlement_days" ADD CONSTRAINT "card_settlement_days_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "card_settlements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_account_cards" ADD CONSTRAINT "customer_account_cards_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "customer_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_account_charges" ADD CONSTRAINT "customer_account_charges_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "customer_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receivable_write_off_attachments" ADD CONSTRAINT "receivable_write_off_attachments_writeOffId_fkey" FOREIGN KEY ("writeOffId") REFERENCES "receivable_write_offs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_voucher_attachments" ADD CONSTRAINT "cash_voucher_attachments_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "cash_voucher_settlements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_voucher_attachments" ADD CONSTRAINT "cash_voucher_attachments_movementId_fkey" FOREIGN KEY ("movementId") REFERENCES "petty_cash_movements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_voucher_settlements" ADD CONSTRAINT "cash_voucher_settlements_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_voucher_settlements" ADD CONSTRAINT "cash_voucher_settlements_voucherId_fkey" FOREIGN KEY ("voucherId") REFERENCES "cash_vouchers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "petty_cash_spend_lines" ADD CONSTRAINT "petty_cash_spend_lines_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "petty_cash_spend_lines" ADD CONSTRAINT "petty_cash_spend_lines_movementId_fkey" FOREIGN KEY ("movementId") REFERENCES "petty_cash_movements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "petty_cash_spend_lines" ADD CONSTRAINT "petty_cash_spend_lines_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "cash_voucher_settlements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ═════════════════════════════════════════════════════════════════════════════
-- (d) Data backfills (plan section 4, in order). Each one is idempotent: its
-- WHERE clause only matches rows it has not fixed yet, so running this block
-- again changes nothing. Two schema objects sit inside this block on purpose:
-- the fixed_assets brand/outlet foreign keys come right after backfill 3 (which
-- clears the dangling and cross-company links they would refuse), and the
-- per-company asset-tag unique right after backfill 4 (which de-duplicates).
-- ═════════════════════════════════════════════════════════════════════════════

-- ── Fixed assets v2 ──────────────────────────────────────────────────────────

-- 1. Cost when capitalised and the in-service month of every legacy asset.
UPDATE "fixed_assets" SET "originalCostCents" = "costCents"
 WHERE "originalCostCents" = 0 AND "costCents" <> 0;
UPDATE "fixed_assets" SET "inServiceAt" = "acquiredAt"
 WHERE "inServiceAt" IS NULL;

-- 2. THE CapEx link, ONE asset per line (critic FA-08). Candidates carry the
--    old 'capex-line:<lineId>' note and no link yet; the line must exist in a
--    project of the asset's own company (the project's company as backfill 7
--    resolves it: its own, else its brand's, else its outlet's). Per line, the
--    asset whose 'fixed_asset.acquire:<id>' entry credited 1340 (advances) or
--    2010 (payable) wins — that is the one the CapEx flow capitalised — else
--    the earliest created. The others stay unlinked; the first boot lists them
--    (flagException 'fixed_asset_gl_mismatch'), never SQL.
WITH candidates AS (
  SELECT fa.id, fa."tenantId", fa."createdAt",
         split_part(substring(fa.notes FROM 12), ' ', 1) AS line_id,
         EXISTS (
           SELECT 1
             FROM "journal_entries" je
             JOIN "journal_lines" jl ON jl."journalEntryId" = je.id
             JOIN "accounts" ac ON ac.id = jl."accountId"
            WHERE je."tenantId" = fa."tenantId"
              AND (je.reference = 'fixed_asset.acquire:' || fa.id
                   OR je.reference LIKE 'fixed_asset.acquire:' || fa.id || '@%')
              AND jl.type = 'credit'
              AND ac.code IN ('1340', '2010')
         ) AS capex_funded
    FROM "fixed_assets" fa
   WHERE fa.notes LIKE 'capex-line:%'
     AND fa."capexLineId" IS NULL
),
eligible AS (
  SELECT c.*
    FROM candidates c
    JOIN "capex_lines" l ON l.id = c.line_id
    JOIN "capex_projects" p ON p.id = l."projectId"
    LEFT JOIN "concepts" pc ON pc.id = p."conceptId"
    LEFT JOIN "locations" pl ON pl.id = p."locationId"
   WHERE COALESCE(p."tenantId", pc."tenantId", pl."tenantId") = c."tenantId"
     AND NOT EXISTS (SELECT 1 FROM "fixed_assets" x WHERE x."capexLineId" = c.line_id)
),
chosen AS (
  SELECT DISTINCT ON (line_id) id, line_id
    FROM eligible
   ORDER BY line_id, capex_funded DESC, "createdAt", id
)
UPDATE "fixed_assets" fa
   SET "capexLineId" = chosen.line_id, "capexLineUnit" = 0
  FROM chosen
 WHERE fa.id = chosen.id;

-- 3. A brand / outlet link that points at a missing row or at ANOTHER company's
--    brand / outlet is cleared (company separation), then the foreign keys.
UPDATE "fixed_assets" fa SET "conceptId" = NULL
 WHERE fa."conceptId" IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM "concepts" c WHERE c.id = fa."conceptId" AND c."tenantId" = fa."tenantId");
UPDATE "fixed_assets" fa SET "locationId" = NULL
 WHERE fa."locationId" IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM "locations" l WHERE l.id = fa."locationId" AND l."tenantId" = fa."tenantId");

-- AddForeignKey
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "concepts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 4. Asset tags become unique per company.
--    4a. The 2nd, 3rd … holder of the same tag in a company (by createdAt) gets
--        '-2', '-3' … appended.
WITH d AS (
  SELECT id, row_number() OVER (PARTITION BY "tenantId", "assetTag" ORDER BY "createdAt", id) AS rn
    FROM "fixed_assets"
   WHERE "assetTag" IS NOT NULL AND btrim("assetTag") <> ''
)
UPDATE "fixed_assets" fa SET "assetTag" = fa."assetTag" || '-' || d.rn
  FROM d
 WHERE fa.id = d.id AND d.rn > 1;
--    4b. Should a suffixed tag collide with a tag that already existed
--        ('X-2' twice), the later one also takes its id's first 8 characters.
WITH d AS (
  SELECT id, row_number() OVER (PARTITION BY "tenantId", "assetTag" ORDER BY "createdAt", id) AS rn
    FROM "fixed_assets"
   WHERE "assetTag" IS NOT NULL AND btrim("assetTag") <> ''
)
UPDATE "fixed_assets" fa SET "assetTag" = fa."assetTag" || '-' || left(fa.id, 8)
  FROM d
 WHERE fa.id = d.id AND d.rn > 1;
--    4c. A blank tag (NULL or empty) gets 'FA-NNNNN' per company in acquiredAt
--        order, numbered above the company's highest numeric 'FA-<digits>' tag
--        (so it can never collide with one). Never truncated past 5 digits.
WITH base AS (
  SELECT "tenantId",
         COALESCE(MAX((substring("assetTag" FROM '^FA-([0-9]{1,15})$'))::bigint), 0) AS top
    FROM "fixed_assets"
   GROUP BY "tenantId"
),
blank AS (
  SELECT id, "tenantId",
         row_number() OVER (PARTITION BY "tenantId" ORDER BY "acquiredAt", "createdAt", id) AS n
    FROM "fixed_assets"
   WHERE "assetTag" IS NULL OR btrim("assetTag") = ''
)
UPDATE "fixed_assets" fa
   SET "assetTag" = 'FA-' || lpad((base.top + blank.n)::text, greatest(5, length((base.top + blank.n)::text)), '0')
  FROM blank
  JOIN base ON base."tenantId" = blank."tenantId"
 WHERE fa.id = blank.id;

-- CreateIndex
CREATE UNIQUE INDEX "fixed_assets_tenantId_assetTag_key" ON "fixed_assets"("tenantId", "assetTag");

-- 5. fixed_asset_depreciation."accumCode" = '1590' on every legacy charge: the
--    column default did it when the column was added. Nothing to run.

-- 6. Every asset disposed before v2 gets its history row (one 'disposal' event,
--    already posted), linked to its 'fixed_asset.dispose:<id>' entry when there
--    is one. payload {"legacy": true} marks it as not entered through v2.
INSERT INTO "fixed_asset_events"
  ("id", "tenantId", "assetId", "kind", "status", "effectiveDate", "payload", "amountCents", "reason",
   "requestedById", "requestedAt", "decidedAt", "postedAt", "journalEntryId", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, fa."tenantId", fa.id, 'disposal', 'posted',
       COALESCE(fa."disposedAt", fa."updatedAt"), '{"legacy": true}'::jsonb, fa."disposalProceedsCents",
       'Recorded before v2', COALESCE(fa."createdById", 'system'),
       COALESCE(fa."disposedAt", fa."updatedAt"), COALESCE(fa."disposedAt", fa."updatedAt"),
       COALESCE(fa."disposedAt", fa."updatedAt"),
       (SELECT je.id FROM "journal_entries" je
         WHERE je."tenantId" = fa."tenantId" AND je.reference = 'fixed_asset.dispose:' || fa.id
         ORDER BY je."createdAt" LIMIT 1),
       now(), now()
  FROM "fixed_assets" fa
 WHERE fa.status = 'disposed'
   AND NOT EXISTS (SELECT 1 FROM "fixed_asset_events" e WHERE e."assetId" = fa.id);

-- 7. A CapEx project with no company takes its brand's, else its outlet's
--    (rows with neither stay NULL — unpostable, listed by the boot check).
UPDATE "capex_projects" p SET "tenantId" = c."tenantId"
  FROM "concepts" c
 WHERE p."tenantId" IS NULL AND p."conceptId" = c.id AND c."tenantId" IS NOT NULL;
UPDATE "capex_projects" p SET "tenantId" = l."tenantId"
  FROM "locations" l
 WHERE p."tenantId" IS NULL AND p."locationId" = l.id AND l."tenantId" IS NOT NULL;

-- 8. 1590 keeps the legacy charges; v2 accumulates per class on 1591-1599.
UPDATE "accounts" SET "name" = 'Accumulated Depreciation (legacy)'
 WHERE "code" = '1590' AND "name" = 'Accumulated Depreciation';

-- ── Controlled accounts (decision P5) ────────────────────────────────────────

-- 9. The register-controlled codes (fixed asset cost 1500-1599 and 2012).
--    Codes added later by ensureChartOfAccounts get it from the template.
UPDATE "accounts" SET "controlledBy" = 'fixed_asset'
 WHERE "tenantId" IS NOT NULL AND "controlledBy" IS NULL
   AND "code" IN ('1500', '1505', '1510', '1515', '1520', '1525', '1530', '1540', '1550', '1560',
                  '1590', '1591', '1592', '1593', '1594', '1595', '1596', '1597', '1598', '1599', '2012');

-- ── Chart text (people + cash) ───────────────────────────────────────────────

-- 10. 2040 is supplier withholding only; salary tax is 2042.
UPDATE "accounts"
   SET "name" = 'Income Tax Withholding Payable (suppliers, s.153)',
       "description" = 'WHT deducted from supplier payments, owed to FBR. Salary tax is 2042.'
 WHERE "code" = '2040' AND "name" = 'Income Tax Withholding Payable';

-- 11. 1010 is the safe; petty-cash boxes are 1011.
UPDATE "accounts" SET "description" = 'Safe / cash on hand (petty-cash boxes are 1011)'
 WHERE "code" = '1010' AND "description" = 'Petty cash / safe';

-- ── Food cost (FIFO lots; packaging by order type + brand vessel) ───────────

-- P1. The brand's primary service vessel (owner's FINAL packaging rule): Stackd
--     serves in packaging on every order; every other brand plates dine-in.
--     ('stax' is Stackd's old slug; stax-padel is a different business and
--     stays 'plate'.)
UPDATE "concepts" SET "serviceVessel" = 'packaging'
 WHERE "slug" IN ('stackd', 'stax') AND "serviceVessel" <> 'packaging';

-- 12. A goods receipt belongs to its supplier's company.
UPDATE "goods_receipts" gr SET "tenantId" = s."tenantId"
  FROM "suppliers" s
 WHERE gr."tenantId" IS NULL AND gr."supplierId" = s.id AND s."tenantId" IS NOT NULL;

-- 13. A waste log belongs to its item's company.
UPDATE "waste_logs" w SET "tenantId" = i."tenantId"
  FROM "inventory_items" i
 WHERE w."tenantId" IS NULL AND w."inventoryItemId" = i.id AND i."tenantId" IS NOT NULL;

-- 14. Item categories onto the one list (lib/inventoryClass.ts
--     INVENTORY_CATEGORIES): lower-case, trimmed, '-' / ' ' → '_'; drink /
--     drinks / beverages / bev → beverage; packing → packaging; anything else
--     not on the list → other. (Cost class: beverage → 1220/5020, packaging →
--     1230/5030, the rest food.)
UPDATE "inventory_items"
   SET "category" = CASE
         WHEN n.c IN ('protein', 'produce', 'dairy', 'dry_goods', 'sauce', 'beverage', 'packaging', 'other') THEN n.c
         WHEN n.c IN ('drink', 'drinks', 'beverages', 'bev') THEN 'beverage'
         WHEN n.c = 'packing' THEN 'packaging'
         ELSE 'other'
       END
  FROM (SELECT id, replace(replace(lower(btrim("category")), '-', '_'), ' ', '_') AS c
          FROM "inventory_items") n
 WHERE "inventory_items".id = n.id
   AND "inventory_items"."category" IS NOT NULL
   AND "inventory_items"."category" NOT IN ('protein', 'produce', 'dairy', 'dry_goods', 'sauce', 'beverage', 'packaging', 'other');

-- 15. Packaging items on a dish's recipe move to its Packaging section (plate
--     recipes only: a menu item, or one waiting to be created on approval).
UPDATE "recipe_ingredients" ri SET "section" = 'packaging'
  FROM "inventory_items" i, "recipes" r
 WHERE ri."inventoryItemId" = i.id
   AND ri."recipeId" = r.id
   AND ri."section" = 'ingredients'
   AND i."category" = 'packaging'
   AND r."kind" = 'plate'
   AND (r."menuItemId" IS NOT NULL OR r."pendingMenuItem" IS NOT NULL);

-- ── Cash (petty cash in the ledger, cash requests) ───────────────────────────

-- 16. A petty-cash movement belongs to its box's company.
UPDATE "petty_cash_movements" m SET "tenantId" = b."tenantId"
  FROM "petty_cash_boxes" b
 WHERE m."tenantId" IS NULL AND m."boxId" = b.id AND b."tenantId" IS NOT NULL;

-- 17. A box-to-box transfer's shared reference, until now only inside reason.
UPDATE "petty_cash_movements"
   SET "transferRef" = substring("reason" FROM 'TRF-[0-9A-F]{8}')
 WHERE "type" = 'transfer' AND "transferRef" IS NULL AND "reason" ~ 'TRF-[0-9A-F]{8}';

-- 18. The spend a (legacy) cash voucher became points back at its voucher.
UPDATE "petty_cash_movements" m SET "cashVoucherId" = v.id
  FROM "cash_vouchers" v
 WHERE m."cashVoucherId" IS NULL AND v."pettyCashMovementId" = m.id;

-- 19. Receipts due 30 days after payment on a paid request. No payeeUserId
--     backfill (critic): the legacy preparedById was the HOD, not the holder —
--     a paid request with no holder is 'needs review', never flagged or
--     converted until finance names one.
UPDATE "cash_vouchers" SET "dueBy" = "disbursedAt" + interval '30 days'
 WHERE "status" = 'disbursed' AND "dueBy" IS NULL AND "disbursedAt" IS NOT NULL;

-- ── Delivery: strikes and bans per company ───────────────────────────────────

-- 20. A strike belongs to the company of its incident: the order's brand's,
--     else the reservation's brand's; a manual strike (no source) takes the
--     recording user's company only when that user belongs to exactly one.
UPDATE "customer_strikes" s SET "tenantId" = c."tenantId"
  FROM "orders" o
  JOIN "concepts" c ON c.id = o."conceptId"
 WHERE s."tenantId" IS NULL AND s."sourceType" = 'order' AND s."sourceId" = o.id AND c."tenantId" IS NOT NULL;
UPDATE "customer_strikes" s SET "tenantId" = c."tenantId"
  FROM "reservations" r
  JOIN "concepts" c ON c.id = r."conceptId"
 WHERE s."tenantId" IS NULL AND s."sourceType" = 'reservation' AND s."sourceId" = r.id AND c."tenantId" IS NOT NULL;
WITH user_companies AS (
  SELECT x.user_id, min(x.t) AS t
    FROM (SELECT u.id AS user_id, u."tenantId" AS t FROM "users" u WHERE u."tenantId" IS NOT NULL
          UNION
          SELECT m."userId", m."tenantId" FROM "tenant_members" m) x
   GROUP BY x.user_id
  HAVING count(DISTINCT x.t) = 1
)
UPDATE "customer_strikes" s SET "tenantId" = uc.t
  FROM user_companies uc
 WHERE s."tenantId" IS NULL AND s."sourceType" IS NULL AND s."recordedById" = uc.user_id;

-- 21. A ban belongs to the company that raised it: a staff ban → the banning
--     user's primary company; an auto ban → X when EVERY non-reversed strike
--     of that customer is company X's.
UPDATE "customer_bans" b SET "tenantId" = u."tenantId"
  FROM "users" u
 WHERE b."tenantId" IS NULL AND b."bannedById" = u.id AND u."tenantId" IS NOT NULL;
WITH single AS (
  SELECT s."customerId", min(s."tenantId") AS t
    FROM "customer_strikes" s
   WHERE s."reversedAt" IS NULL
   GROUP BY s."customerId"
  HAVING count(*) = count(s."tenantId") AND count(DISTINCT s."tenantId") = 1
)
UPDATE "customer_bans" b SET "tenantId" = single.t
  FROM single
 WHERE b."tenantId" IS NULL AND b."bannedById" IS NULL AND b."customerId" = single."customerId";

-- 22. A legacy ACTIVE auto ban whose customer's strikes span two or more
--     companies is split: one copy per company (same identifiers and reason,
--     bannedAt kept), and the original is lifted. A company that already has
--     an active auto ban for the customer gets no second one. Truly
--     unattributable bans stay NULL (the CEO lifts; appeals go to the refusing
--     brand's company).
WITH multi AS (
  SELECT b.id AS ban_id, st.t
    FROM "customer_bans" b
    JOIN LATERAL (
      SELECT DISTINCT s."tenantId" AS t
        FROM "customer_strikes" s
       WHERE s."customerId" = b."customerId" AND s."reversedAt" IS NULL AND s."tenantId" IS NOT NULL
    ) st ON true
   WHERE b."tenantId" IS NULL AND b."bannedById" IS NULL AND b."liftedAt" IS NULL AND b."customerId" IS NOT NULL
     AND (SELECT count(DISTINCT s2."tenantId")
            FROM "customer_strikes" s2
           WHERE s2."customerId" = b."customerId" AND s2."reversedAt" IS NULL AND s2."tenantId" IS NOT NULL) >= 2
),
copies AS (
  INSERT INTO "customer_bans"
    ("id", "customerId", "email", "phone", "ipAddresses", "deviceFingerprints", "reason", "tenantId",
     "bannedById", "bannedAt", "expiresAt")
  SELECT gen_random_uuid()::text, b."customerId", b."email", b."phone", b."ipAddresses", b."deviceFingerprints",
         b."reason", multi.t, NULL, b."bannedAt", b."expiresAt"
    FROM multi
    JOIN "customer_bans" b ON b.id = multi.ban_id
   WHERE NOT EXISTS (
     SELECT 1 FROM "customer_bans" x
      WHERE x."customerId" = b."customerId" AND x."tenantId" = multi.t
        AND x."bannedById" IS NULL AND x."liftedAt" IS NULL)
  RETURNING 1
)
UPDATE "customer_bans" b
   SET "liftedAt" = now(), "liftReason" = 'split per company (2026-10-14)'
 WHERE b.id IN (SELECT ban_id FROM multi);

-- 22b. Before the one-active-auto-ban-per-company unique below: the old
--      check-then-create in strikes.ts could race into two active auto bans
--      for one customer, and backfill 21 can give both the same company. The
--      earliest stays; the others are lifted (kept for the record).
WITH d AS (
  SELECT id, row_number() OVER (PARTITION BY "tenantId", "customerId" ORDER BY "bannedAt", id) AS rn
    FROM "customer_bans"
   WHERE "liftedAt" IS NULL AND "bannedById" IS NULL AND "customerId" IS NOT NULL AND "tenantId" IS NOT NULL
)
UPDATE "customer_bans" b
   SET "liftedAt" = now(), "liftReason" = 'duplicate auto ban (2026-10-14)'
  FROM d
 WHERE b.id = d.id AND d.rn > 1;

-- ─── SQL-only objects (plan sections 5 and 6) ────────────────────────────────
-- Partial / expression unique indexes, one composite foreign key and CHECK
-- constraints that schema.prisma cannot express (each is commented on its
-- model there and never re-declared). tests/setup.ts applies this section
-- after `db push` straight from this file: from this marker to the
-- row-level-security marker, full-line comments dropped, split on ';' — so no
-- statement here may contain a ';' or a trailing comment. They come AFTER the
-- backfills above that make them hold on existing rows.

-- (e) Partial / expression unique indexes
CREATE INDEX "stock_lots_open_fifo" ON "stock_lots" ("inventoryItemId", "receivedAt", "id")
  WHERE "remainingQty" > 0.000001;
CREATE UNIQUE INDEX "fixed_assets_capex_unit_live" ON "fixed_assets" ("tenantId", "capexLineId", "capexLineUnit")
  WHERE "capexLineId" IS NOT NULL AND "status" <> 'voided';
CREATE UNIQUE INDEX "fixed_asset_pools_key" ON "fixed_asset_pools" ("tenantId", "locationId", COALESCE("conceptId", ''), "classKey", "typeKey");
CREATE UNIQUE INDEX "fixed_asset_events_pending_capitalise" ON "fixed_asset_events" ("tenantId", "capexLineId")
  WHERE "kind" = 'capitalise' AND "status" = 'pending';
CREATE UNIQUE INDEX "fixed_asset_events_one_pending_per_asset" ON "fixed_asset_events" ("assetId", "kind")
  WHERE "status" = 'pending' AND "assetId" IS NOT NULL;
CREATE UNIQUE INDEX "capex_projects_standing" ON "capex_projects" ("tenantId", "locationId")
  WHERE "isStanding" AND "deletedAt" IS NULL;
CREATE UNIQUE INDEX "accounts_ic_pair_side" ON "accounts" ("tenantId", "counterpartyTenantId", "type")
  WHERE "controlledBy" = 'intercompany';
CREATE UNIQUE INDEX "customer_bans_one_active_auto_per_company" ON "customer_bans" ("tenantId", "customerId")
  WHERE "liftedAt" IS NULL AND "bannedById" IS NULL AND "customerId" IS NOT NULL AND "tenantId" IS NOT NULL;
CREATE UNIQUE INDEX "order_complaints_one_open_appeal_per_ban" ON "order_complaints" ("banId")
  WHERE "kind" = 'ban_appeal' AND "status" IN ('open', 'in_progress');
CREATE UNIQUE INDEX "receivable_write_offs_one_open" ON "receivable_write_offs" ("invoiceId")
  WHERE "status" = 'requested';
-- Documentation index: the GRNI write-off claim itself is a conditional update
-- (writeOffRequestedAt IS NULL), this only marks the open requests.
CREATE UNIQUE INDEX "goods_receipt_lines_one_open_writeoff" ON "goods_receipt_lines" ("id")
  WHERE "writeOffRequestedAt" IS NOT NULL AND "writtenOffAt" IS NULL;

-- Composite foreign key: a fleet rate's (provider, client) pair must be an
-- agreement's (fleet_agreements has @@unique([providerTenantId, clientTenantId])).
ALTER TABLE "fleet_rates" ADD CONSTRAINT "fleet_rates_agreement_pair_fkey"
  FOREIGN KEY ("tenantId", "clientTenantId") REFERENCES "fleet_agreements" ("providerTenantId", "clientTenantId");

-- (f) CHECK constraints
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_fy_end_month_chk" CHECK ("fiscalYearEndMonth" BETWEEN 1 AND 12);
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_controlled_by_chk"
  CHECK ("controlledBy" IS NULL OR "controlledBy" IN ('intercompany', 'head_office', 'fixed_asset'));
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_controlled_company_chk"
  CHECK ("controlledBy" IS NULL OR "tenantId" IS NOT NULL);
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_ic_counterparty_chk"
  CHECK ("controlledBy" IS DISTINCT FROM 'intercompany'
         OR ("counterpartyTenantId" IS NOT NULL AND "counterpartyTenantId" <> "tenantId"));
ALTER TABLE "concepts" ADD CONSTRAINT "concepts_service_vessel_chk"
  CHECK ("serviceVessel" IN ('plate', 'packaging'));
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_service_vessel_chk"
  CHECK ("serviceVessel" IS NULL OR "serviceVessel" IN ('plate', 'packaging'));
ALTER TABLE "stock_lots" ADD CONSTRAINT "stock_lots_class_chk" CHECK ("costClass" IN ('food', 'beverage', 'packaging'));
ALTER TABLE "stock_lots" ADD CONSTRAINT "stock_lots_remaining_chk"
  CHECK ("remainingQty" >= -0.000001 AND "remainingValueCents" >= 0);
ALTER TABLE "stock_lots" ADD CONSTRAINT "stock_lots_source_chk"
  CHECK ("sourceType" IN ('goods_receipt_line', 'count_gain', 'opening', 'fifo_cutover', 'legacy_return'));
-- 'transfer_out' / 'transfer_in' are reserved for per-outlet stock (the next
-- build); wave B never writes them.
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_kind_chk"
  CHECK ("kind" IN ('receipt', 'opening', 'fifo_cutover', 'count_gain', 'count_loss', 'sale', 'sale_return',
                    'sale_void', 'waste', 'prep_draw', 'supplier_return', 'cost_adjust', 'class_reclass',
                    'legacy_return', 'issue_on_receipt', 'shortfall_settle', 'transfer_out', 'transfer_in'));
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_class_chk" CHECK ("costClass" IN ('food', 'beverage', 'packaging'));
ALTER TABLE "grni_matches" ADD CONSTRAINT "grni_matches_status_chk" CHECK ("status" IN ('live', 'pending', 'void'));
ALTER TABLE "physical_counts" ADD CONSTRAINT "physical_counts_kind_chk" CHECK ("kind" IN ('spot', 'opening'));
ALTER TABLE "recipe_ingredients" ADD CONSTRAINT "recipe_ingredients_section_chk"
  CHECK ("section" IN ('ingredients', 'packaging'));
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_settled_chk"
  CHECK (("settledByType" IS NULL) = ("settledById" IS NULL)
         AND ("settledByType" IS NULL OR "settledByType" IN ('petty_cash_movement', 'cash_voucher_settlement')));
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_quantity_chk" CHECK ("quantity" >= 0);
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_kind_chk" CHECK ("kind" IN ('individual', 'pool_layer'));
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_status_chk" CHECK ("status" IN ('active', 'disposed', 'voided'));
ALTER TABLE "fixed_asset_events" ADD CONSTRAINT "fixed_asset_events_status_chk"
  CHECK ("status" IN ('pending', 'posted', 'rejected', 'cancelled'));
ALTER TABLE "prepaid_releases" ADD CONSTRAINT "prepaid_releases_source_chk"
  CHECK ("sourceType" IN ('capex_payment', 'opex_payment'));
ALTER TABLE "capex_lines" ADD CONSTRAINT "capex_lines_treatment_chk"
  CHECK ("treatment" IS NULL OR "treatment" IN ('capital', 'prepaid', 'deposit', 'expense'));
ALTER TABLE "opex_payments" ADD CONSTRAINT "opex_payments_treatment_chk" CHECK ("treatment" IN ('expense', 'prepaid'));
ALTER TABLE "intercompany_transfers" ADD CONSTRAINT "ic_amount_chk" CHECK ("amountCents" > 0);
ALTER TABLE "intercompany_transfers" ADD CONSTRAINT "ic_parties_chk" CHECK ("tenantId" <> "counterpartyTenantId");
ALTER TABLE "intercompany_transfers" ADD CONSTRAINT "ic_kind_chk" CHECK ("kind" IN ('charge', 'settlement', 'netting'));
ALTER TABLE "intercompany_transfers" ADD CONSTRAINT "ic_status_chk"
  CHECK ("status" IN ('submitted', 'posted', 'rejected', 'reversed'));
ALTER TABLE "intercompany_transfers" ADD CONSTRAINT "ic_source_chk"
  CHECK ("source" IN ('manual', 'fleet', 'cod', 'ho_recharge'));
ALTER TABLE "intercompany_transfers" ADD CONSTRAINT "ic_sourceref_chk" CHECK (("source" = 'manual') = ("sourceRef" IS NULL));
ALTER TABLE "intercompany_transfers" ADD CONSTRAINT "ic_method_chk" CHECK (("kind" = 'settlement') = ("method" IS NOT NULL));
ALTER TABLE "fleet_rates" ADD CONSTRAINT "fleet_rates_rate_chk" CHECK ("ratePerTripCents" >= 0);
ALTER TABLE "fleet_rates" ADD CONSTRAINT "fleet_rates_period_chk" CHECK ("fromPeriod" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');
ALTER TABLE "fleet_rates" ADD CONSTRAINT "fleet_rates_parties_chk" CHECK ("tenantId" <> "clientTenantId");
ALTER TABLE "card_settlements" ADD CONSTRAINT "card_settlements_status_chk"
  CHECK ("status" IN ('auto', 'confirmed', 'manual_adjust'));
ALTER TABLE "customer_accounts" ADD CONSTRAINT "customer_accounts_chk"
  CHECK ("creditLimitCents" >= 0 AND "termsDays" BETWEEN 1 AND 180 AND "overdueGraceDays" BETWEEN 0 AND 90);
ALTER TABLE "customer_account_charges" ADD CONSTRAINT "customer_account_charges_chk"
  CHECK ("amountCents" > 0 AND "refundedCents" >= 0 AND "refundedCents" <= "amountCents");
ALTER TABLE "receivable_invoices" ADD CONSTRAINT "receivable_invoices_written_off_chk" CHECK ("writtenOffCents" >= 0);
ALTER TABLE "receivable_write_offs" ADD CONSTRAINT "receivable_write_offs_chk"
  CHECK ("amountCents" > 0 AND "recoveredCents" >= 0 AND "recoveredCents" <= "amountCents");
ALTER TABLE "cash_vouchers" ADD CONSTRAINT "cash_vouchers_counters_chk"
  CHECK ("settledCents" >= 0 AND "returnedCents" >= 0 AND "convertedCents" >= 0
         AND "settledCents" + "returnedCents" + "convertedCents" <= "amountCents");
ALTER TABLE "cash_voucher_attachments" ADD CONSTRAINT "cash_voucher_attachments_owner_chk"
  CHECK ("voucherId" IS NOT NULL OR "boxId" IS NOT NULL OR "movementId" IS NOT NULL);
ALTER TABLE "petty_cash_spend_lines" ADD CONSTRAINT "petty_cash_spend_lines_owner_chk"
  CHECK (num_nonnulls("movementId", "settlementId") = 1);
ALTER TABLE "petty_cash_spend_lines" ADD CONSTRAINT "petty_cash_spend_lines_amount_chk" CHECK ("amountCents" > 0);
ALTER TABLE "petty_cash_spend_lines" ADD CONSTRAINT "petty_cash_spend_lines_kind_chk"
  CHECK ("kind" IN ('expense', 'stock', 'capex'));
ALTER TABLE "petty_cash_spend_lines" ADD CONSTRAINT "petty_cash_spend_lines_stock_chk"
  CHECK ("kind" <> 'stock' OR ("inventoryItemId" IS NOT NULL AND "quantity" > 0));
ALTER TABLE "petty_cash_spend_lines" ADD CONSTRAINT "petty_cash_spend_lines_capex_chk"
  CHECK ("kind" <> 'capex' OR "capexLineId" IS NOT NULL);
ALTER TABLE "petty_cash_movements" ADD CONSTRAINT "petty_cash_movements_source_chk"
  CHECK ("source" IS NULL OR "source" IN ('garibsons', 'safe', 'bank', 'till', 'cash_request', 'opening', 'box'));
ALTER TABLE "order_complaints" ADD CONSTRAINT "order_complaints_kind_chk" CHECK ("kind" IN ('complaint', 'ban_appeal'));
ALTER TABLE "orders" ADD CONSTRAINT "orders_return_cause_chk"
  CHECK ("returnCause" IS NULL OR "returnCause" IN ('refused', 'unreachable', 'other'));

-- ─── Row-level security (plan section 7) ─────────────────────────────────────
-- The wave-A guarded pattern: only where the RLS helper functions exist (the
-- test database is built with db push and has none). Workers and boot jobs use
-- serviceClient; route READS use the RLS client.
DO $do$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'app_is_service_mode')
     AND EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'app_tenant_ids') THEN
    -- New and newly scoped company tables: service mode, or the caller's companies.
    FOREACH t IN ARRAY ARRAY[
      'stock_lots', 'stock_movements', 'grni_matches', 'fixed_assets', 'fixed_asset_depreciation',
      'fixed_asset_classes', 'fixed_asset_pools', 'fixed_asset_events', 'fixed_asset_tax_years', 'fixed_asset_runs',
      'prepaid_releases', 'card_settlements', 'card_settlement_days', 'customer_accounts', 'customer_account_cards',
      'customer_account_charges', 'receivable_write_offs', 'receivable_write_off_attachments', 'cash_voucher_settlements',
      'petty_cash_spend_lines', 'cash_vouchers', 'cash_voucher_attachments'
    ]
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

    -- Two-party tables: either company sees the row.
    ALTER TABLE "intercompany_transfers" ENABLE ROW LEVEL SECURITY;
    CREATE POLICY intercompany_transfers_rls ON "intercompany_transfers" FOR ALL
      USING (app_is_service_mode() OR "tenantId" = ANY(app_tenant_ids()) OR "counterpartyTenantId" = ANY(app_tenant_ids()))
      WITH CHECK (app_is_service_mode() OR "tenantId" = ANY(app_tenant_ids()) OR "counterpartyTenantId" = ANY(app_tenant_ids()));
    ALTER TABLE "fleet_rates" ENABLE ROW LEVEL SECURITY;
    CREATE POLICY fleet_rates_rls ON "fleet_rates" FOR ALL
      USING (app_is_service_mode() OR "tenantId" = ANY(app_tenant_ids()) OR "clientTenantId" = ANY(app_tenant_ids()))
      WITH CHECK (app_is_service_mode() OR "tenantId" = ANY(app_tenant_ids()) OR "clientTenantId" = ANY(app_tenant_ids()));

    -- petty_cash_movements: from the staff-only catch-all (20260603074000) to
    -- the company policy now that tenantId is stamped (legacy NULL rows stay
    -- visible to staff — the pattern that migration uses for nullable-company
    -- tables).
    DROP POLICY IF EXISTS petty_cash_movements_rls ON "petty_cash_movements";
    CREATE POLICY petty_cash_movements_rls ON "petty_cash_movements" FOR ALL
      USING (app_is_service_mode() OR ("tenantId" IS NULL AND app_has_any_tenant()) OR "tenantId" = ANY(app_tenant_ids()))
      WITH CHECK (app_is_service_mode() OR ("tenantId" IS NULL AND app_has_any_tenant()) OR "tenantId" = ANY(app_tenant_ids()));
  END IF;
END
$do$;
