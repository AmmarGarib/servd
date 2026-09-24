-- AlterTable
ALTER TABLE "hr_payroll_runs" ADD COLUMN     "preparedByIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

