-- 20261105160000_login_offboard_requests — HR's offboard of a login waits for
-- the CEO (owner, 2026-11-05: "Give option to HR for off boarding a
-- user/employee with final approval of CEO").
--
-- One row per request. tenantId = the TARGET login's company. Approval type
-- staff_offboard (CEO only, never handed over). Nothing changes on the login
-- until the CEO approves. Nothing is dropped.
--
-- Runbook: if this migration fails on deploy, run
--   prisma migrate resolve --rolled-back 20261105160000_login_offboard_requests
-- in the api image before redeploying any image (P3009 blocks every image).
SET lock_timeout = '10s';

CREATE TABLE "login_offboard_requests" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "requestedById" TEXT NOT NULL,
  "decidedById" TEXT,
  "decidedAt" TIMESTAMP(3),
  "decisionNote" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "login_offboard_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "login_offboard_requests_tenantId_status_idx" ON "login_offboard_requests"("tenantId", "status");
CREATE INDEX "login_offboard_requests_userId_idx" ON "login_offboard_requests"("userId");

-- ─── SQL-only objects (one statement per ';', no trailing comments)
CREATE UNIQUE INDEX "login_offboard_requests_one_pending" ON "login_offboard_requests"("userId") WHERE "status" = 'pending';
ALTER TABLE "login_offboard_requests" ADD CONSTRAINT "login_offboard_requests_status_chk" CHECK ("status" IN ('pending', 'approved', 'rejected', 'withdrawn'));
ALTER TABLE "login_offboard_requests" ADD CONSTRAINT "login_offboard_requests_reason_chk" CHECK (char_length(btrim("reason")) >= 10);

-- ─── Row-level security (the guarded wave-A/B pattern, as 20261026130100_station_change_requests).
DO $do$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'app_is_service_mode')
     AND EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'app_tenant_ids') THEN
    FOREACH t IN ARRAY ARRAY['login_offboard_requests']
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
