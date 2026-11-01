-- The approver returns a payroll for correction (owner, 2026-11-01: "all approvals should be returnable").
ALTER TABLE "hr_payroll_runs" ADD COLUMN IF NOT EXISTS "ceoReturnNote" TEXT;
ALTER TABLE "hr_payroll_runs" ADD COLUMN IF NOT EXISTS "ceoReturnedById" TEXT;
ALTER TABLE "hr_payroll_runs" ADD COLUMN IF NOT EXISTS "ceoReturnedAt" TIMESTAMP(3);
