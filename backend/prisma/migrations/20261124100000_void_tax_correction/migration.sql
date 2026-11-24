-- A void of a buyer's pay-back voucher may carry the bill's CORRECT sales tax (owner, 2026-11-24): the excess tax is
-- credited on the bill before the fresh pay-back voucher is raised. NULL = a plain void.
ALTER TABLE "cash_voucher_void_requests" ADD COLUMN "correctTaxCents" INTEGER;
