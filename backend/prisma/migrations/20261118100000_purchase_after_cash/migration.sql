-- Purchasing flow (owner, 2026-11-18): the buyer is paid back after the CEO approves the GRN (no advance), and the
-- receiver picks stock or expense per received line.
ALTER TABLE "purchase_orders" ADD COLUMN "cashAfterPurchase" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "cash_vouchers" ADD COLUMN "reimbursesBillId" TEXT;
CREATE UNIQUE INDEX "cash_vouchers_reimbursesBillId_key" ON "cash_vouchers"("reimbursesBillId");
ALTER TABLE "goods_receipt_lines" ADD COLUMN "expenseAccountCode" TEXT;
