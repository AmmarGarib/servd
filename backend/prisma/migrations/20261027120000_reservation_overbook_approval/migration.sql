-- 20261027120000_reservation_overbook_approval — overbooking goes to the CEO
-- (owner C10, 2026-10-26: "overbooking should auto come to ceo for approval.
-- Manager shouldnt be able to do that without approval.").
--
-- A booking past capacity raised by anyone but the CEO is stored with status
-- pending_approval (off the floor plan, capacity, reminders and the
-- no-overlap constraint, which covers booked / confirmed / seated only) and a
-- reservation_overbook_requests row of kind create; a CHANGE of a live booking
-- that goes past capacity is a row of kind edit and leaves the booking as it
-- is. tenantId = the BRAND's company. Approval type reservation_overbook (CEO
-- only, never handed over). Nothing is dropped.
--
-- ALTER TYPE … ADD VALUE: the new value is not used in this migration.
--
-- Runbook: if this migration fails on deploy, run
--   prisma migrate resolve --rolled-back 20261027120000_reservation_overbook_approval
-- in the api image before redeploying any image (P3009 blocks every image).
-- Rollback caveat: once a reservation is pending_approval an older Prisma
-- client throws on the enum value — decide or cancel them first.
SET lock_timeout = '10s';

ALTER TYPE "ReservationStatus" ADD VALUE IF NOT EXISTS 'pending_approval';

CREATE TABLE "reservation_overbook_requests" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "reservationId" TEXT NOT NULL,
  "conceptId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "changes" JSONB NOT NULL DEFAULT '{}',
  "reason" TEXT NOT NULL,
  "managerApproverId" TEXT,
  "viaPin" BOOLEAN NOT NULL DEFAULT false,
  "reservationUpdatedAt" TIMESTAMP(3),
  "status" TEXT NOT NULL DEFAULT 'pending',
  "requestedById" TEXT NOT NULL,
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decidedById" TEXT,
  "decidedAt" TIMESTAMP(3),
  "decisionNote" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "reservation_overbook_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "reservation_overbook_requests_tenantId_status_idx" ON "reservation_overbook_requests"("tenantId", "status");
CREATE INDEX "reservation_overbook_requests_reservationId_idx" ON "reservation_overbook_requests"("reservationId");

-- ─── SQL-only objects (one statement per ';', no trailing comments)
CREATE UNIQUE INDEX "reservation_overbook_requests_one_pending" ON "reservation_overbook_requests"("reservationId") WHERE "status" = 'pending';
ALTER TABLE "reservation_overbook_requests" ADD CONSTRAINT "reservation_overbook_requests_kind_chk" CHECK ("kind" IN ('create', 'edit'));
ALTER TABLE "reservation_overbook_requests" ADD CONSTRAINT "reservation_overbook_requests_status_chk" CHECK ("status" IN ('pending', 'approved', 'rejected', 'cancelled'));
ALTER TABLE "reservation_overbook_requests" ADD CONSTRAINT "reservation_overbook_requests_reason_chk" CHECK (length(btrim("reason")) >= 3);

-- ─── Row-level security (the guarded pattern, as 20261026130100_station_change_requests).
DO $do$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'app_is_service_mode')
     AND EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'app_tenant_ids') THEN
    FOREACH t IN ARRAY ARRAY['reservation_overbook_requests']
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
