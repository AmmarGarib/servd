-- Cash vouchers, 2026-10-15 flow (owner): request → finance approval → CEO final approval → pay (held on 1357) →
-- supporting documents → finance verifies → expense booked. Adds a kind ('request' staff / 'expense' finance-raised
-- for a payee), a discount, finance approval, "return for correction", the documents check and the posting stamp.
-- Additive only: every existing row is a 'request' with discount 0 and expenseOnVerify false (H3 rules).

-- New status values. ALTER TYPE ... ADD VALUE cannot run inside a transaction block on old Postgres; Prisma runs
-- each migration file in one transaction, and PG >= 12 allows ADD VALUE there as long as the value is not used in
-- the same transaction (it is not).
ALTER TYPE "CashVoucherStatus" ADD VALUE IF NOT EXISTS 'submitted';
ALTER TYPE "CashVoucherStatus" ADD VALUE IF NOT EXISTS 'finance_approved';
ALTER TYPE "CashVoucherStatus" ADD VALUE IF NOT EXISTS 'returned';
ALTER TYPE "CashVoucherStatus" ADD VALUE IF NOT EXISTS 'posted';

CREATE TYPE "CashVoucherKind" AS ENUM ('request', 'expense');

ALTER TABLE "cash_vouchers"
  ADD COLUMN "kind" "CashVoucherKind" NOT NULL DEFAULT 'request',
  ADD COLUMN "grossCents" INTEGER,
  ADD COLUMN "discountCents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "submittedById" TEXT,
  ADD COLUMN "submittedAt" TIMESTAMP(3),
  ADD COLUMN "financeApprovedById" TEXT,
  ADD COLUMN "financeApprovedAt" TIMESTAMP(3),
  ADD COLUMN "expenseOnVerify" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "returnedById" TEXT,
  ADD COLUMN "returnedAt" TIMESTAMP(3),
  ADD COLUMN "returnNote" TEXT,
  ADD COLUMN "returnCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "docsVerifiedById" TEXT,
  ADD COLUMN "docsVerifiedAt" TIMESTAMP(3),
  ADD COLUMN "postedAt" TIMESTAMP(3),
  ADD COLUMN "postedById" TEXT,
  ADD COLUMN "postedJournalEntryId" TEXT;

CREATE UNIQUE INDEX "cash_vouchers_postedJournalEntryId_key" ON "cash_vouchers"("postedJournalEntryId");
CREATE INDEX "cash_vouchers_tenantId_kind_status_idx" ON "cash_vouchers"("tenantId", "kind", "status");

ALTER TABLE "cash_voucher_attachments" ADD COLUMN "fileName" TEXT;

-- 1357 Petty Cash Vouchers Awaiting Documents is added to every company's chart by ensureChartOfAccounts at boot
-- (lib/chartOfAccounts.ts; required code, so /health checks it).

-- ─── SQL-only objects (tests/setup.ts reads from here to the end: no ';' inside a statement, no trailing comments)
-- amount paid = gross − discount; a discount is never negative and never the whole amount.
ALTER TABLE "cash_vouchers" ADD CONSTRAINT "cash_vouchers_discount_chk" CHECK (
  "discountCents" >= 0
  AND ("grossCents" IS NULL AND "discountCents" = 0 OR "grossCents" IS NOT NULL AND "grossCents" = "amountCents" + "discountCents")
);
