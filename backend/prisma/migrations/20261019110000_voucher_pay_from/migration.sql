-- "To pay from" on a finance payee voucher (owner, 2026-10-19): Cash / Bank / Credit chosen when it is raised.
-- Cash and bank prefill finance's pay; credit books a supplier bill at finance's pay (no cash leaves) — paySource
-- 'credit', supplierBillId = that bill. Additive and nullable. ROLLBACK: once a voucher is paid on credit
-- (paySource 'credit') an older image's CHECK would refuse it — never roll the API back below this release then.
ALTER TABLE "cash_vouchers"
  ADD COLUMN "plannedPaySource"     TEXT,
  ADD COLUMN "plannedBankAccountId" TEXT,
  ADD COLUMN "supplierId"           TEXT,
  ADD COLUMN "supplierBillId"       TEXT;

CREATE UNIQUE INDEX "cash_vouchers_supplierBillId_key" ON "cash_vouchers"("supplierBillId");

-- The pay-source CHECK of 20261016160000 learns 'credit' (no money account: the supplier is owed).
ALTER TABLE "cash_vouchers" DROP CONSTRAINT IF EXISTS "cash_vouchers_pay_source_chk";

-- ─── SQL-only objects (tests/setup.ts reads this section: no ';' inside a statement)
ALTER TABLE "cash_vouchers" ADD CONSTRAINT "cash_vouchers_pay_source_credit_chk" CHECK (
  "paySource" IN ('box', 'cash_on_hand', 'bank', 'credit')
  AND ("paySource" IN ('box', 'credit') OR "payAccountCode" IS NOT NULL OR "disbursedAt" IS NULL)
  AND ("paySource" <> 'credit' OR "supplierId" IS NOT NULL)
);
ALTER TABLE "cash_vouchers" ADD CONSTRAINT "cash_vouchers_planned_pay_chk" CHECK (
  ("plannedPaySource" IS NULL OR "plannedPaySource" IN ('cash', 'bank', 'credit'))
  AND ("plannedPaySource" IS DISTINCT FROM 'credit' OR "supplierId" IS NOT NULL)
  AND ("plannedBankAccountId" IS NULL OR "plannedPaySource" = 'bank')
);
