-- Owner, 2026-10-30: "How HR will push payroll to finance for review?" — "HR sends to finance, then CEO".
-- A payroll run now goes draft → finance_review (HR sent it) → finance_checked (finance passed it) → approved (the
-- CEO / co-owner / management) → locked → paid. `status` stays a plain text column; these record who did each step.
-- Runs already approved or locked are untouched; a draft keeps going through the new steps.
ALTER TABLE "hr_payroll_runs"
  ADD COLUMN "sentToFinanceById" TEXT,
  ADD COLUMN "sentToFinanceAt" TIMESTAMP(3),
  ADD COLUMN "financeCheckedById" TEXT,
  ADD COLUMN "financeCheckedAt" TIMESTAMP(3),
  ADD COLUMN "financeNote" TEXT,
  ADD COLUMN "financeReturnNote" TEXT,
  ADD COLUMN "financeReturnedById" TEXT,
  ADD COLUMN "financeReturnedAt" TIMESTAMP(3);
