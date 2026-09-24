-- AlterTable
ALTER TABLE "hr_payroll_runs" ADD COLUMN     "preparedByIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- HR payroll is the only payroll: it records when wages were paid out.
ALTER TABLE "hr_payroll_runs" ADD COLUMN     "paidAt" TIMESTAMP(3);
