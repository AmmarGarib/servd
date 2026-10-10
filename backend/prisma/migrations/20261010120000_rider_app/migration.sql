-- Rider app v1 (owner decisions 2026-10-10, docs/rider-app.md).
--
--   1. Order: the current rider's job stages (offered / accepted / picked up /
--      at the door). deliveredAt already exists.
--   2. rider_job_events: every step of every rider job, stamped with the
--      ORDER's company (tenantId, the client) and the rider's company
--      (riderTenantId, the provider fleet) — what a later cost split reads.
--   3. fleet_agreements: provider company -> client company. The one
--      deliberate exception to company separation: a rider of A may carry an
--      order of B only while an active agreement (A -> B) exists.
--   4. riders.phone normalised to 92... digits (auth/otp.ts normalisePhone) —
--      the rider signs in with a WhatsApp code to this number.
--   5. orders(riderId, deliveredAt) — "orders on this rider's hands" is read on
--      every rider-app request and every location fix.

-- CreateEnum
CREATE TYPE "RiderJobEventType" AS ENUM ('offered', 'accepted', 'declined', 'timed_out', 'picked_up', 'arrived', 'delivered', 'otp_failed', 'unassigned');

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "arrivedAt" TIMESTAMP(3),
ADD COLUMN     "pickedUpAt" TIMESTAMP(3),
ADD COLUMN     "riderAcceptedAt" TIMESTAMP(3),
ADD COLUMN     "riderAssignedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "orders_riderId_deliveredAt_idx" ON "orders"("riderId", "deliveredAt");

-- CreateTable
CREATE TABLE "rider_job_events" (
    "id" TEXT NOT NULL,
    "riderId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "riderTenantId" TEXT NOT NULL,
    "type" "RiderJobEventType" NOT NULL,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rider_job_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fleet_agreements" (
    "id" TEXT NOT NULL,
    "providerTenantId" TEXT NOT NULL,
    "clientTenantId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fleet_agreements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "rider_job_events_orderId_idx" ON "rider_job_events"("orderId");

-- CreateIndex
CREATE INDEX "rider_job_events_riderId_createdAt_idx" ON "rider_job_events"("riderId", "createdAt");

-- CreateIndex
CREATE INDEX "rider_job_events_tenantId_createdAt_idx" ON "rider_job_events"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "fleet_agreements_clientTenantId_idx" ON "fleet_agreements"("clientTenantId");

-- CreateIndex
CREATE UNIQUE INDEX "fleet_agreements_providerTenantId_clientTenantId_key" ON "fleet_agreements"("providerTenantId", "clientTenantId");

-- AddForeignKey
ALTER TABLE "rider_job_events" ADD CONSTRAINT "rider_job_events_riderId_fkey" FOREIGN KEY ("riderId") REFERENCES "riders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rider_job_events" ADD CONSTRAINT "rider_job_events_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fleet_agreements" ADD CONSTRAINT "fleet_agreements_providerTenantId_fkey" FOREIGN KEY ("providerTenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fleet_agreements" ADD CONSTRAINT "fleet_agreements_clientTenantId_fkey" FOREIGN KEY ("clientTenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── Row-level security (same helpers as 20260603074000_enable_rls_phase4) ──
-- A job event is visible to both companies it names; an agreement to both
-- sides of it. Service mode (workers) sees everything, as everywhere else.
--
-- The `riders` policy (phase 4: own company only) is deliberately NOT widened
-- for fleet partners. A client company's staff (B) acting on a B order carried
-- by a provider's rider (A) — marking it delivered, unassigning, cancelling —
-- touches A's rider row. Instead of a policy clause, those reads and writes run
-- in service mode: backend/src/modules/dispatch/service.ts uses serviceClient
-- once the caller has resolved the order through its own company scope, and
-- the dispatch board reads fleet partners through serviceClient with explicit
-- company filters on the riders and their orders. A policy clause ("a rider
-- carrying an order of mine") would need an orders sub-select on every riders
-- read, and could not hold for the delivered write itself (the order is no
-- longer "carried" by the time the rider row is updated).
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'app_is_service_mode')
     AND EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'app_tenant_ids') THEN
    ALTER TABLE "rider_job_events" ENABLE ROW LEVEL SECURITY;
    CREATE POLICY rider_job_events_rls ON "rider_job_events" FOR ALL
      USING (
        app_is_service_mode()
        OR "rider_job_events"."tenantId" = ANY(app_tenant_ids())
        OR "rider_job_events"."riderTenantId" = ANY(app_tenant_ids())
      )
      WITH CHECK (
        app_is_service_mode()
        OR "rider_job_events"."tenantId" = ANY(app_tenant_ids())
        OR "rider_job_events"."riderTenantId" = ANY(app_tenant_ids())
      );

    ALTER TABLE "fleet_agreements" ENABLE ROW LEVEL SECURITY;
    CREATE POLICY fleet_agreements_rls ON "fleet_agreements" FOR ALL
      USING (
        app_is_service_mode()
        OR "fleet_agreements"."providerTenantId" = ANY(app_tenant_ids())
        OR "fleet_agreements"."clientTenantId" = ANY(app_tenant_ids())
      )
      WITH CHECK (
        app_is_service_mode()
        OR "fleet_agreements"."providerTenantId" = ANY(app_tenant_ids())
        OR "fleet_agreements"."clientTenantId" = ANY(app_tenant_ids())
      );
  END IF;
END
$do$;

-- ─── Normalise riders.phone ─────────────────────────────────────────────────
-- Mirrors normalisePhone() in backend/src/modules/auth/otp.ts exactly:
--   strip every non-digit; a leading 0092 (international 00 prefix) loses the
--   00; 92 + a trunk 0 + 9-10 digits ('+92 (0)300…') loses the 0; a leading
--   92 stays; a leading 0 becomes 92; a bare 10-digit number gets 92 in
--   front; anything else is left as digits.
--
-- riders.phone is UNIQUE, so two rows that normalise to the same number
-- cannot both hold it. Per the owner's rule, BOTH rows are kept: the row that
-- already holds the normalised value keeps it, otherwise the earliest-created
-- row is normalised, and every later row in the collision is LEFT
-- UN-NORMALISED (and listed in a NOTICE). The rider sign-in matches on the
-- normalised number and refuses to guess between two riders, so neither can
-- sign in until a manager fixes the duplicate in admin -> Riders.
-- Rows with no digits at all are left as they are.
DO $do$
DECLARE
  dup RECORD;
  updated integer;
BEGIN
  CREATE TEMP TABLE _rider_phone_norm ON COMMIT DROP AS
  SELECT id, phone, np,
         row_number() OVER (
           PARTITION BY np
           ORDER BY (phone = np) DESC, "createdAt" ASC, id ASC
         ) AS rn
  FROM (
    SELECT id, phone, "createdAt",
      CASE
        WHEN d ~ '^920[0-9]{9,10}$' THEN '92' || substr(d, 4)
        WHEN d LIKE '92%'    THEN d
        WHEN d LIKE '0%'     THEN '92' || substr(d, 2)
        WHEN length(d) = 10  THEN '92' || d
        ELSE d
      END AS np
    FROM (
      SELECT id, phone, "createdAt",
        CASE WHEN d0 LIKE '0092%' THEN substr(d0, 3) ELSE d0 END AS d
      FROM (SELECT id, phone, "createdAt", regexp_replace(phone, '\D', '', 'g') AS d0 FROM "riders") s0
    ) s
  ) n
  WHERE np <> '';

  UPDATE "riders" r
     SET phone = x.np
    FROM _rider_phone_norm x
   WHERE r.id = x.id
     AND x.rn = 1
     AND r.phone <> x.np
     AND NOT EXISTS (SELECT 1 FROM "riders" o WHERE o.phone = x.np AND o.id <> r.id);
  GET DIAGNOSTICS updated = ROW_COUNT;
  RAISE NOTICE 'rider_app: normalised % rider phone number(s)', updated;

  FOR dup IN
    SELECT x.id, x.phone, x.np FROM _rider_phone_norm x WHERE x.rn > 1 AND x.phone <> x.np
  LOOP
    RAISE NOTICE 'rider_app: rider % kept un-normalised (%): another rider already holds %',
      dup.id, dup.phone, dup.np;
  END LOOP;
END
$do$;
