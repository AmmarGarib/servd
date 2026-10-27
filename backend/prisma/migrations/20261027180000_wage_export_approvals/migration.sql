-- 20261027180000_wage_export_approvals — owner decision 2026-10-27: a wage change and a guest-list download
-- go through the manager channel first and the CEO gives the FINAL approval.
--
--   • Wage changes need NO table: they are HR salary-revision requests (hr_records, the HR request engine)
--     whose last step is the CEO (hr/service.ts workflowOf). Approval type wage_change.
--   • Guest-list downloads (phones / emails): one row per request in customer_export_requests. tenantId =
--     the requester's active company. Approved = one download by the requester within 24 hours. Approval
--     type customer_export (the CEO only, not handed over yet). Nothing is dropped.
--
-- Runbook: if this migration fails on deploy, run
--   prisma migrate resolve --rolled-back 20261027180000_wage_export_approvals
-- in the api image before redeploying any image (P3009 blocks every image).
SET lock_timeout = '10s';

CREATE TABLE "customer_export_requests" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "filters" JSONB NOT NULL DEFAULT '{}',
  "reason" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "requestedById" TEXT NOT NULL,
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decidedById" TEXT,
  "decidedAt" TIMESTAMP(3),
  "decisionNote" TEXT,
  "expiresAt" TIMESTAMP(3),
  "downloadedAt" TIMESTAMP(3),
  "rowCount" INTEGER,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "customer_export_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "customer_export_requests_tenantId_status_idx" ON "customer_export_requests"("tenantId", "status");
CREATE INDEX "customer_export_requests_requestedById_idx" ON "customer_export_requests"("requestedById");

-- ─── SQL-only objects (one statement per ';', no trailing comments)
ALTER TABLE "customer_export_requests" ADD CONSTRAINT "customer_export_requests_kind_chk" CHECK ("kind" IN ('customers', 'waitlist'));
ALTER TABLE "customer_export_requests" ADD CONSTRAINT "customer_export_requests_status_chk" CHECK ("status" IN ('pending', 'approved', 'rejected', 'cancelled'));
ALTER TABLE "customer_export_requests" ADD CONSTRAINT "customer_export_requests_reason_chk" CHECK (length(btrim("reason")) >= 10);
ALTER TABLE "customer_export_requests" ADD CONSTRAINT "customer_export_requests_approved_chk" CHECK (("status" = 'approved') = ("expiresAt" IS NOT NULL) AND ("downloadedAt" IS NULL OR "status" = 'approved'));

-- ─── Row-level security (the guarded wave-A/B pattern, as 20261026130100_station_change_requests).
DO $do$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'app_is_service_mode')
     AND EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'app_tenant_ids') THEN
    FOREACH t IN ARRAY ARRAY['customer_export_requests']
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
