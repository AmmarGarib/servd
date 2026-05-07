-- Payroll: per-employee wage rates + payroll run history
ALTER TABLE "users" ADD COLUMN "hourlyRateCents" INTEGER;
ALTER TABLE "users" ADD COLUMN "wageAccountCode" TEXT;

CREATE TYPE "PayrollRunStatus" AS ENUM ('draft', 'posted', 'paid');

CREATE TABLE "payroll_runs" (
  "id"              TEXT             NOT NULL,
  "periodStart"     TIMESTAMP(3)     NOT NULL,
  "periodEnd"       TIMESTAMP(3)     NOT NULL,
  "status"          "PayrollRunStatus" NOT NULL DEFAULT 'draft',
  "totalGrossCents" INTEGER          NOT NULL DEFAULT 0,
  "postedAt"        TIMESTAMP(3),
  "paidAt"          TIMESTAMP(3),
  "createdById"     TEXT,
  "notes"           TEXT,
  "createdAt"       TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3)     NOT NULL,

  CONSTRAINT "payroll_runs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "payroll_runs_periodStart_idx" ON "payroll_runs" ("periodStart" DESC);

CREATE TABLE "payroll_run_lines" (
  "id"              TEXT          NOT NULL,
  "payrollRunId"    TEXT          NOT NULL,
  "userId"          TEXT          NOT NULL,
  "userName"        TEXT          NOT NULL,
  "hoursWorked"     DOUBLE PRECISION NOT NULL,
  "hourlyRateCents" INTEGER       NOT NULL,
  "grossCents"      INTEGER       NOT NULL,
  "wageAccountCode" TEXT          NOT NULL,
  "adjustmentCents" INTEGER       NOT NULL DEFAULT 0,
  "netCents"        INTEGER       NOT NULL,
  "notes"           TEXT,

  CONSTRAINT "payroll_run_lines_pkey"      PRIMARY KEY ("id"),
  CONSTRAINT "payroll_run_lines_runFk"     FOREIGN KEY ("payrollRunId") REFERENCES "payroll_runs"("id") ON DELETE CASCADE,
  CONSTRAINT "payroll_run_lines_userFk"    FOREIGN KEY ("userId")       REFERENCES "users"("id")        ON DELETE NO ACTION
);
CREATE INDEX "payroll_run_lines_runId_idx"  ON "payroll_run_lines" ("payrollRunId");
CREATE INDEX "payroll_run_lines_userId_idx" ON "payroll_run_lines" ("userId");
