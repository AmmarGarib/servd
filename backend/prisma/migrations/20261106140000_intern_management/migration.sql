-- 20261106140000_intern_management — Intern Management (owner, 2026-11-06). Interns are a SEPARATE category from
-- employees: their own register (interns, INT-0001 per company), history (intern_events), attendance marked by HR /
-- the supervisor (intern_attendance), stipend payroll (intern_payroll_runs / intern_stipend_slips — booked Dr 6038
-- Intern Stipends / Cr 2025 Stipends Payable at the CEO's approval) and certificates (intern_certificates).
-- Company data: tenantId on every table, RLS (the guarded pattern of 20261106120000), repointed by the company merge.
-- The marketing tracker may now point at an intern (marketing_trackees.internId; employeeId nullable, kept for
-- history). The move of the retired 'intern' employment type into the register is a boot step
-- (modules/hr/internsMigration.ts migrateLegacyInterns), not SQL: it needs the Trash and the record-files store.
-- Nothing is dropped.
--
-- Runbook: if this migration fails on deploy, run
--   prisma migrate resolve --rolled-back 20261106140000_intern_management
-- in the api image before redeploying any image (P3009 blocks every image).
SET lock_timeout = '10s';

ALTER TABLE "marketing_trackees" ADD COLUMN     "internId" TEXT,
ALTER COLUMN "employeeId" DROP NOT NULL;

CREATE TABLE "interns" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "internCode" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "fatherName" TEXT,
    "cnic" TEXT,
    "dateOfBirth" DATE,
    "gender" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "address" TEXT,
    "emergencyContactName" TEXT,
    "emergencyContactPhone" TEXT,
    "institution" TEXT,
    "degree" TEXT,
    "fieldOfStudy" TEXT,
    "semester" TEXT,
    "studentRegNo" TEXT,
    "departmentId" TEXT,
    "designation" TEXT,
    "supervisorEmployeeId" TEXT,
    "startDate" DATE NOT NULL,
    "endDate" DATE,
    "internshipType" TEXT NOT NULL DEFAULT 'unpaid',
    "monthlyStipendCents" INTEGER NOT NULL DEFAULT 0,
    "workingDays" JSONB NOT NULL DEFAULT '[1,2,3,4,5,6]',
    "workingHours" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending_approval',
    "rejectionNote" TEXT,
    "submittedById" TEXT,
    "submittedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "terminationReason" TEXT,
    "terminationEffectiveDate" DATE,
    "completedOn" DATE,
    "completedAt" TIMESTAMP(3),
    "userId" TEXT,
    "performanceRemarks" TEXT,
    "legacyEmployeeId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "interns_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "intern_events" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "internId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "note" TEXT,
    "before" JSONB,
    "after" JSONB,
    "effectiveDate" DATE,
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "intern_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "intern_attendance" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "internId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "status" TEXT NOT NULL,
    "checkIn" TEXT,
    "checkOut" TEXT,
    "note" TEXT,
    "source" TEXT NOT NULL DEFAULT 'hr',
    "markedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "intern_attendance_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "intern_payroll_runs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "totals" JSONB NOT NULL DEFAULT '{}',
    "createdById" TEXT,
    "preparedByIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sentToFinanceById" TEXT,
    "sentToFinanceAt" TIMESTAMP(3),
    "financeCheckedById" TEXT,
    "financeCheckedAt" TIMESTAMP(3),
    "financeNote" TEXT,
    "financeReturnNote" TEXT,
    "financeReturnedById" TEXT,
    "financeReturnedAt" TIMESTAMP(3),
    "ceoReturnNote" TEXT,
    "ceoReturnedById" TEXT,
    "ceoReturnedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "accrualEntryId" TEXT,
    "paidById" TEXT,
    "paidAt" TIMESTAMP(3),
    "paidOn" DATE,
    "paymentMethod" TEXT,
    "paymentBankAccountId" TEXT,
    "paymentReference" TEXT,
    "paymentEntryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "intern_payroll_runs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "intern_stipend_slips" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "internId" TEXT NOT NULL,
    "monthlyStipendCents" INTEGER NOT NULL,
    "daysInMonth" INTEGER NOT NULL,
    "daysEngaged" INTEGER NOT NULL,
    "absentDays" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "halfDays" INTEGER NOT NULL DEFAULT 0,
    "unpaidLeaveDays" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "paidDays" DOUBLE PRECISION NOT NULL,
    "baseCents" INTEGER NOT NULL,
    "additionsCents" INTEGER NOT NULL DEFAULT 0,
    "deductionsCents" INTEGER NOT NULL DEFAULT 0,
    "netCents" INTEGER NOT NULL,
    "adjustments" JSONB NOT NULL DEFAULT '[]',
    "breakdown" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "intern_stipend_slips_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "intern_certificates" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "internId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'generated',
    "remarks" TEXT,
    "generatedById" TEXT,
    "issuedById" TEXT,
    "issuedAt" TIMESTAMP(3),
    "reissueOfId" TEXT,
    "reissueReason" TEXT,
    "supersededAt" TIMESTAMP(3),
    "supersededById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "intern_certificates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "interns_userId_key" ON "interns"("userId");

CREATE UNIQUE INDEX "interns_legacyEmployeeId_key" ON "interns"("legacyEmployeeId");

CREATE INDEX "interns_tenantId_status_idx" ON "interns"("tenantId", "status");

CREATE INDEX "interns_supervisorEmployeeId_idx" ON "interns"("supervisorEmployeeId");

CREATE UNIQUE INDEX "interns_tenantId_internCode_key" ON "interns"("tenantId", "internCode");

CREATE INDEX "intern_events_internId_createdAt_idx" ON "intern_events"("internId", "createdAt");

CREATE INDEX "intern_events_tenantId_idx" ON "intern_events"("tenantId");

CREATE INDEX "intern_attendance_tenantId_date_idx" ON "intern_attendance"("tenantId", "date");

CREATE UNIQUE INDEX "intern_attendance_internId_date_key" ON "intern_attendance"("internId", "date");

CREATE INDEX "intern_payroll_runs_tenantId_status_idx" ON "intern_payroll_runs"("tenantId", "status");

CREATE UNIQUE INDEX "intern_payroll_runs_tenantId_period_key" ON "intern_payroll_runs"("tenantId", "period");

CREATE INDEX "intern_stipend_slips_internId_idx" ON "intern_stipend_slips"("internId");

CREATE INDEX "intern_stipend_slips_tenantId_idx" ON "intern_stipend_slips"("tenantId");

CREATE UNIQUE INDEX "intern_stipend_slips_runId_internId_key" ON "intern_stipend_slips"("runId", "internId");

CREATE INDEX "intern_certificates_internId_idx" ON "intern_certificates"("internId");

CREATE UNIQUE INDEX "intern_certificates_tenantId_number_key" ON "intern_certificates"("tenantId", "number");

CREATE UNIQUE INDEX "marketing_trackees_tenantId_internId_key" ON "marketing_trackees"("tenantId", "internId");

ALTER TABLE "intern_events" ADD CONSTRAINT "intern_events_internId_fkey" FOREIGN KEY ("internId") REFERENCES "interns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "intern_attendance" ADD CONSTRAINT "intern_attendance_internId_fkey" FOREIGN KEY ("internId") REFERENCES "interns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "intern_stipend_slips" ADD CONSTRAINT "intern_stipend_slips_runId_fkey" FOREIGN KEY ("runId") REFERENCES "intern_payroll_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "intern_stipend_slips" ADD CONSTRAINT "intern_stipend_slips_internId_fkey" FOREIGN KEY ("internId") REFERENCES "interns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "intern_certificates" ADD CONSTRAINT "intern_certificates_internId_fkey" FOREIGN KEY ("internId") REFERENCES "interns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "marketing_trackees" ADD CONSTRAINT "marketing_trackees_internId_fkey" FOREIGN KEY ("internId") REFERENCES "interns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── SQL-only objects (one statement per ';', no trailing comments)
CREATE UNIQUE INDEX "intern_certificates_one_live" ON "intern_certificates"("internId") WHERE "supersededAt" IS NULL;
ALTER TABLE "interns" ADD CONSTRAINT "interns_status_chk" CHECK ("status" IN ('draft', 'pending_approval', 'active', 'completed', 'terminated'));
ALTER TABLE "interns" ADD CONSTRAINT "interns_stipend_chk" CHECK (("internshipType" = 'paid' AND "monthlyStipendCents" > 0) OR ("internshipType" = 'unpaid' AND "monthlyStipendCents" = 0));
ALTER TABLE "interns" ADD CONSTRAINT "interns_dates_chk" CHECK ("endDate" IS NULL OR "endDate" >= "startDate");
ALTER TABLE "intern_attendance" ADD CONSTRAINT "intern_attendance_status_chk" CHECK ("status" IN ('present', 'absent', 'late', 'half_day', 'leave', 'weekly_off'));
ALTER TABLE "intern_payroll_runs" ADD CONSTRAINT "intern_payroll_runs_status_chk" CHECK ("status" IN ('draft', 'finance_review', 'finance_checked', 'approved', 'paid'));
ALTER TABLE "intern_certificates" ADD CONSTRAINT "intern_certificates_status_chk" CHECK ("status" IN ('generated', 'issued', 'reissued'));
ALTER TABLE "marketing_trackees" ADD CONSTRAINT "marketing_trackees_person_chk" CHECK ("employeeId" IS NOT NULL OR "internId" IS NOT NULL);

-- ─── Row-level security (the guarded wave-A/B pattern, as 20261106120000_performance_evaluations).
DO $do$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'app_is_service_mode')
     AND EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'app_tenant_ids') THEN
    FOREACH t IN ARRAY ARRAY['interns', 'intern_events', 'intern_attendance', 'intern_payroll_runs', 'intern_stipend_slips', 'intern_certificates']
    LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename = t) THEN
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format(
          'CREATE POLICY %I ON %I FOR ALL '
          'USING (app_is_service_mode() OR %I."tenantId" = ANY(app_tenant_ids())) '
          'WITH CHECK (app_is_service_mode() OR %I."tenantId" = ANY(app_tenant_ids()))',
          t || '_rls', t, t, t);
      END IF;
    END LOOP;
  END IF;
END
$do$;
