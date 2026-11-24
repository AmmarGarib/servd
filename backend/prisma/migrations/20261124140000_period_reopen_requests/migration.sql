-- 20261124140000_period_reopen_requests — finance asks the CEO to reopen a closed period (owner, 2026-11-24:
-- "Where to request to open a closed period to do postings in that closed period?" → "Build both").
-- One row per ask (tenantId = the company whose books are closed); one pending per company is kept in code under an
-- advisory lock (accounting/periodReopen.ts). Nothing is dropped.
--
-- Runbook: if this migration fails on deploy, run
--   prisma migrate resolve --rolled-back 20261124140000_period_reopen_requests
-- in the api image before redeploying any image (P3009 blocks every image).
SET lock_timeout = '10s';

CREATE TABLE "period_reopen_requests" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "lockedThrough" TIMESTAMP(3) NOT NULL,
  "reason" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "requestedById" TEXT NOT NULL,
  "decidedById" TEXT,
  "decidedAt" TIMESTAMP(3),
  "decisionNote" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "period_reopen_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "period_reopen_requests_tenantId_status_idx" ON "period_reopen_requests"("tenantId", "status");

-- ─── SQL-only objects (one statement per ';', no trailing comments)
ALTER TABLE "period_reopen_requests" ADD CONSTRAINT "period_reopen_requests_status_chk" CHECK ("status" IN ('pending', 'approved', 'rejected', 'withdrawn'));
ALTER TABLE "period_reopen_requests" ADD CONSTRAINT "period_reopen_requests_reason_chk" CHECK (char_length(btrim("reason")) >= 10);

-- ─── Row-level security (the guarded wave-A/B pattern, as 20261118120000_cash_voucher_void).
DO $do$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'app_is_service_mode')
     AND EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'app_tenant_ids') THEN
    FOREACH t IN ARRAY ARRAY['period_reopen_requests']
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
