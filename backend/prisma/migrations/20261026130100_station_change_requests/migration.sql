-- 20261026130100_station_change_requests — kitchen stations raised by the F&B
-- manager or the chef, applied when the CEO approves (owner C3, 2026-10-26:
-- "F&B manager and kitchen managers may add or change kitchen stations, with
-- CEO approval" / "Approval stays with me").
--
-- One row per request: kind create (a new station on a brand) or update (a
-- rename, re-order, switch on / off or brand move of an existing station).
-- tenantId = the BRAND's company. Approval type station_change (CEO only,
-- never handed over). Nothing is dropped.
--
-- Runbook: if this migration fails on deploy, run
--   prisma migrate resolve --rolled-back 20261026130100_station_change_requests
-- in the api image before redeploying any image (P3009 blocks every image).
SET lock_timeout = '10s';

CREATE TABLE "station_change_requests" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "conceptId" TEXT NOT NULL,
  "stationId" TEXT,
  "kind" TEXT NOT NULL,
  "changes" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "requestedById" TEXT NOT NULL,
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decidedById" TEXT,
  "decidedAt" TIMESTAMP(3),
  "decisionNote" TEXT,
  "appliedStationId" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "station_change_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "station_change_requests_tenantId_status_idx" ON "station_change_requests"("tenantId", "status");
CREATE INDEX "station_change_requests_stationId_idx" ON "station_change_requests"("stationId");

-- ─── SQL-only objects (one statement per ';', no trailing comments)
CREATE UNIQUE INDEX "station_change_requests_one_pending" ON "station_change_requests"("stationId") WHERE "status" = 'pending' AND "stationId" IS NOT NULL;
ALTER TABLE "station_change_requests" ADD CONSTRAINT "station_change_requests_kind_chk" CHECK ("kind" IN ('create', 'update') AND (("kind" = 'create') = ("stationId" IS NULL)));
ALTER TABLE "station_change_requests" ADD CONSTRAINT "station_change_requests_status_chk" CHECK ("status" IN ('pending', 'approved', 'rejected', 'cancelled'));

-- ─── Row-level security (the guarded wave-A/B pattern, as 20261021100000_shift_corrections).
DO $do$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'app_is_service_mode')
     AND EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'app_tenant_ids') THEN
    FOREACH t IN ARRAY ARRAY['station_change_requests']
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
