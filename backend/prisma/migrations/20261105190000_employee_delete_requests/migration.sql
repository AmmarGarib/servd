-- 20261105190000_employee_delete_requests — HR deletes an employee with the
-- CEO's approval (owner, 2026-11-05: "Give option to HR to delete employee from
-- list with CEO's approval").
--
-- One row per request. tenantId = the EMPLOYEE's company. employeeId is a plain
-- id (no FK): the request outlives the deleted employee row, and code + name
-- are kept as a snapshot. Approval type employee_delete (CEO only, never handed
-- over). Nothing changes on the employee until the CEO approves; the deleted
-- employee sits in the Trash (type hr_employee) and the CEO can restore it.
-- Nothing is dropped.
--
-- Runbook: if this migration fails on deploy, run
--   prisma migrate resolve --rolled-back 20261105190000_employee_delete_requests
-- in the api image before redeploying any image (P3009 blocks every image).
SET lock_timeout = '10s';

CREATE TABLE "employee_delete_requests" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "employeeId" TEXT NOT NULL,
  "employeeCode" TEXT NOT NULL,
  "fullName" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "requestedById" TEXT NOT NULL,
  "decidedById" TEXT,
  "decidedAt" TIMESTAMP(3),
  "decisionNote" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "employee_delete_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "employee_delete_requests_tenantId_status_idx" ON "employee_delete_requests"("tenantId", "status");
CREATE INDEX "employee_delete_requests_employeeId_idx" ON "employee_delete_requests"("employeeId");

-- ─── SQL-only objects (one statement per ';', no trailing comments)
CREATE UNIQUE INDEX "employee_delete_requests_one_pending" ON "employee_delete_requests"("employeeId") WHERE "status" = 'pending';
ALTER TABLE "employee_delete_requests" ADD CONSTRAINT "employee_delete_requests_status_chk" CHECK ("status" IN ('pending', 'approved', 'rejected', 'withdrawn'));
ALTER TABLE "employee_delete_requests" ADD CONSTRAINT "employee_delete_requests_reason_chk" CHECK (char_length(btrim("reason")) >= 10);

-- ─── Row-level security (the guarded wave-A/B pattern, as 20261105160000_login_offboard_requests).
DO $do$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'app_is_service_mode')
     AND EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'app_tenant_ids') THEN
    FOREACH t IN ARRAY ARRAY['employee_delete_requests']
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
