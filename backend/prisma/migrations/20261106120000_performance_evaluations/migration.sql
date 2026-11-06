-- 20261106120000_performance_evaluations — employee self-evaluation & performance appraisal (owner,
-- 2026-11-06). Replaces the old "Performance reviews" HR section (its records stay readable). Company data:
-- tenantId on every table, RLS (the guarded pattern of 20261105190000), repointed by the company merge.
--
-- Runbook: if this migration fails on deploy, run
--   prisma migrate resolve --rolled-back 20261106120000_performance_evaluations
-- in the api image before redeploying any image (P3009 blocks every image).
SET lock_timeout = '10s';

CREATE TABLE "performance_cycles" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "periodFrom" DATE NOT NULL,
  "periodTo" DATE NOT NULL,
  "dueDate" DATE,
  "areas" JSONB NOT NULL,
  "selfWeightBp" INTEGER NOT NULL DEFAULT 3000,
  "status" TEXT NOT NULL DEFAULT 'open',
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "performance_cycles_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "performance_cycles_tenantId_status_idx" ON "performance_cycles"("tenantId", "status");

CREATE TABLE "performance_templates" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "questions" JSONB NOT NULL,
  "ownerUserId" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "performance_templates_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "performance_templates_tenantId_active_idx" ON "performance_templates"("tenantId", "active");

CREATE TABLE "performance_evaluations" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "cycleId" TEXT NOT NULL,
  "employeeId" TEXT NOT NULL,
  "managerEmployeeId" TEXT,
  "managerUserId" TEXT NOT NULL,
  "assignedById" TEXT NOT NULL,
  "dueDate" DATE,
  "status" TEXT NOT NULL DEFAULT 'pending_employee',
  "areas" JSONB NOT NULL,
  "questions" JSONB NOT NULL,
  "selfWeightBp" INTEGER NOT NULL,
  "self" JSONB NOT NULL DEFAULT '{}',
  "manager" JSONB NOT NULL DEFAULT '{}',
  "selfScore" INTEGER,
  "managerScore" INTEGER,
  "finalScore" INTEGER,
  "category" TEXT,
  "returnNote" TEXT,
  "returnCount" INTEGER NOT NULL DEFAULT 0,
  "history" JSONB NOT NULL DEFAULT '[]',
  "submittedAt" TIMESTAMP(3),
  "managerStartedAt" TIMESTAMP(3),
  "finalizedAt" TIMESTAMP(3),
  "employeeAckAt" TIMESTAMP(3),
  "reopenedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "performance_evaluations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "performance_evaluations_cycleId_employeeId_key" ON "performance_evaluations"("cycleId", "employeeId");
CREATE INDEX "performance_evaluations_tenantId_status_idx" ON "performance_evaluations"("tenantId", "status");
CREATE INDEX "performance_evaluations_managerUserId_idx" ON "performance_evaluations"("managerUserId");
CREATE INDEX "performance_evaluations_employeeId_idx" ON "performance_evaluations"("employeeId");
ALTER TABLE "performance_evaluations" ADD CONSTRAINT "performance_evaluations_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "performance_cycles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "performance_evaluations" ADD CONSTRAINT "performance_evaluations_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "hr_employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── Row-level security (the guarded wave-A/B pattern, as 20261105190000_employee_delete_requests).
DO $do$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'app_is_service_mode')
     AND EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'app_tenant_ids') THEN
    FOREACH t IN ARRAY ARRAY['performance_cycles', 'performance_templates', 'performance_evaluations']
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
