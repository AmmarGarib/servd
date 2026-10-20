-- Internal payment classification chosen when a cash voucher is raised (owner, 2026-10-20: "Why there's no option
-- for off/unoff in payee voucher?"). Finance / the CEO pick Official / Unofficial / Unclassified (+ tax status) on
-- the form; finance's pay stamps it on the payment entry (payment_classifications), unless the pay names another.
-- A label only. Additive and nullable — an older image ignores the columns.
ALTER TABLE "cash_vouchers"
  ADD COLUMN "plannedClassification"     TEXT,
  ADD COLUMN "plannedTaxStatus"          TEXT,
  ADD COLUMN "plannedNonDeductionReason" TEXT;

-- ─── SQL-only objects (tests/setup.ts reads this section: no ';' inside a statement)
ALTER TABLE "cash_vouchers" ADD CONSTRAINT "cash_vouchers_planned_classification_chk" CHECK (
  ("plannedClassification" IS NULL OR "plannedClassification" IN ('official', 'unofficial', 'unclassified'))
  AND ("plannedTaxStatus" IS NULL OR ("plannedClassification" IS NOT NULL AND "plannedTaxStatus" IN ('deducted', 'not_deducted', 'not_applicable')))
  AND ("plannedTaxStatus" IS DISTINCT FROM 'not_deducted' OR length(btrim(coalesce("plannedNonDeductionReason", ''))) >= 10)
);
