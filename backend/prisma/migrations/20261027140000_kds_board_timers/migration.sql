-- 20261027140000_kds_board_timers — the station screen's visible window, Start
-- and cook timers (owner B12, 2026-10-26: "Their screen should probs show them
-- 4-6 orders at a time … option for them to start timer … multiple timers …
-- Timer going off should just make the order card blink red.. no noise").
--
--   stations.visibleCards        4–6 order cards shown at once (default 5).
--   order_items.startedAt        a line with no recipe steps: the cook tapped Start.
--   order_items.kdsShownAt       / order_item_steps.kdsShownAt: when the card first
--                                showed in its station's visible window — the expo's
--                                60-second "not started" alert reads it.
--   kitchen_timers               a countdown (started at + duration) per dish / step,
--                                tenantId = the order's company, RLS.
-- Nothing is dropped.
--
-- Runbook: if this migration fails on deploy, run
--   prisma migrate resolve --rolled-back 20261027140000_kds_board_timers
-- in the api image before redeploying any image (P3009 blocks every image).
SET lock_timeout = '10s';

ALTER TABLE "stations" ADD COLUMN "visibleCards" INTEGER NOT NULL DEFAULT 5;
ALTER TABLE "order_items" ADD COLUMN "startedAt" TIMESTAMP(3);
ALTER TABLE "order_items" ADD COLUMN "kdsShownAt" TIMESTAMP(3);
ALTER TABLE "order_item_steps" ADD COLUMN "kdsShownAt" TIMESTAMP(3);

CREATE TABLE "kitchen_timers" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "orderItemId" TEXT NOT NULL,
  "orderItemStepId" TEXT,
  "stationId" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "durationSeconds" INTEGER NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "endsAt" TIMESTAMP(3) NOT NULL,
  "stoppedAt" TIMESTAMP(3),
  "startedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "kitchen_timers_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "kitchen_timers_tenantId_idx" ON "kitchen_timers"("tenantId");
CREATE INDEX "kitchen_timers_stationId_stoppedAt_idx" ON "kitchen_timers"("stationId", "stoppedAt");
CREATE INDEX "kitchen_timers_orderId_idx" ON "kitchen_timers"("orderId");

-- ─── SQL-only objects (one statement per ';', no trailing comments)
ALTER TABLE "stations" ADD CONSTRAINT "stations_visible_cards_chk" CHECK ("visibleCards" BETWEEN 4 AND 6);
ALTER TABLE "kitchen_timers" ADD CONSTRAINT "kitchen_timers_duration_chk" CHECK ("durationSeconds" BETWEEN 1 AND 14400);

-- ─── Row-level security (the guarded wave-A/B pattern, as 20261026130100_station_change_requests).
DO $do$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'app_is_service_mode')
     AND EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'app_tenant_ids') THEN
    FOREACH t IN ARRAY ARRAY['kitchen_timers']
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
