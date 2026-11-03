-- Non-food items and the PO approval chain (owner, 2026-11-03).
--
-- 1. Non-food stock items ("want to use this system for non food purposes …
--    Expense on receipt"): category 'non_food' (no DB CHECK on the category —
--    lib/inventoryClass.ts INVENTORY_CATEGORIES is the list). Its lots and
--    movements carry the lot class 'non_food', so the class CHECKs of wave B
--    learn it. Account 6045 Operating Supplies (Non-food) is added to every
--    company's chart at boot by ensureChartOfAccounts (lib/chartOfAccounts.ts).
--
-- 2. The PO approval chain ("PO goes to Asif. Asif push to Hasnain. Hasnain
--    push to me. approved by me. asif takes cash from hasnain. asif buys.
--    person that created po marks received"): purchase_orders.status gains
--    'buyer_check' and 'finance_check' before 'pending_approval' (the CEO's
--    step; the column is free text, no CHECK). Each step is stamped; a return
--    sends it back to draft with a note. The CEO's approval raises a cash
--    voucher tied to the PO (cash_vouchers.purchaseOrderId, one per PO) in the
--    buyer's name; finance's pay of it tops up the buyer's petty-cash box.

ALTER TABLE "purchase_orders"
  ADD COLUMN "submittedById" TEXT,
  ADD COLUMN "submittedAt" TIMESTAMP(3),
  ADD COLUMN "buyerCheckedById" TEXT,
  ADD COLUMN "buyerCheckedAt" TIMESTAMP(3),
  ADD COLUMN "financeCheckedById" TEXT,
  ADD COLUMN "financeCheckedAt" TIMESTAMP(3),
  ADD COLUMN "returnedById" TEXT,
  ADD COLUMN "returnedAt" TIMESTAMP(3),
  ADD COLUMN "returnNote" TEXT,
  ADD COLUMN "returnCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "payByCash" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "cash_vouchers" ADD COLUMN "purchaseOrderId" TEXT;
CREATE UNIQUE INDEX "cash_vouchers_purchaseOrderId_key" ON "cash_vouchers"("purchaseOrderId");

ALTER TABLE "stock_lots" DROP CONSTRAINT IF EXISTS "stock_lots_class_chk";
ALTER TABLE "stock_movements" DROP CONSTRAINT IF EXISTS "stock_movements_class_chk";

-- ─── SQL-only objects (read by tests/setup.ts: no ';' inside a statement, no trailing comments)
ALTER TABLE "stock_lots" ADD CONSTRAINT "stock_lots_class_chk" CHECK ("costClass" IN ('food', 'beverage', 'packaging', 'non_food'));
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_class_chk" CHECK ("costClass" IN ('food', 'beverage', 'packaging', 'non_food'));
