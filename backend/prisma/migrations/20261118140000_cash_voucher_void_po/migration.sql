-- Void a PO's cash voucher (owner, 2026-11-18: "Add voiding for PO vouchers too").
-- A voided pay-back voucher keeps the bill it repaid here; its reimbursesBillId is cleared so a new pay-back can be raised.
ALTER TABLE "cash_vouchers" ADD COLUMN IF NOT EXISTS "voidedBillId" TEXT;
CREATE INDEX IF NOT EXISTS "cash_vouchers_voidedBillId_idx" ON "cash_vouchers" ("voidedBillId");
