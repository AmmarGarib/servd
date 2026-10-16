-- Finance audit 2026-10-17 item 22: a month may take a second (top-up)
-- challan — a late F&F or adjustment raises October's EOBI after October's
-- challan was recorded, or a supplementary sales-tax payment. The old key
-- (one payment per company, authority and period start) is replaced by:
--   * a plain index for the period lookups, and
--   * one row per challan / CPR number within the period (NULLs are distinct
--     in Postgres, so the FIRST payment of a period may still have no CPR;
--     the code requires a CPR on every top-up — taxPayments.ts).
-- Rollback: an older image catches only the old key's P2002; with two rows
-- for one period, re-creating the old unique index fails — void the top-up
-- first.
DROP INDEX IF EXISTS "sales_tax_payments_tenantId_authority_periodFrom_key";
CREATE INDEX IF NOT EXISTS "sales_tax_payments_tenantId_authority_periodFrom_idx" ON "sales_tax_payments"("tenantId", "authority", "periodFrom");
CREATE UNIQUE INDEX IF NOT EXISTS "sales_tax_payments_tenantId_authority_periodFrom_cprNumber_key" ON "sales_tax_payments"("tenantId", "authority", "periodFrom", "cprNumber");
