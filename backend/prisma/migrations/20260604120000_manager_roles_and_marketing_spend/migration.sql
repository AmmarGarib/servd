-- Two new manager roles + the marketing-spend input that powers the Brand
-- Manager dashboard's CAC / CRC / ROAS metrics.

-- ── New UserRole enum values ────────────────────────────────────────────────
-- Postgres 12+ allows ADD VALUE inside a transaction as long as the new value
-- isn't USED in the same transaction (we don't). IF NOT EXISTS keeps it
-- idempotent across re-runs / baseline replays.
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'brand_manager';
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'fnb_manager';

-- ── marketing_spend ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "marketing_spend" (
  "id"               TEXT NOT NULL,
  "tenantId"         TEXT,
  "conceptId"        TEXT NOT NULL,
  "month"            TEXT NOT NULL,
  "acquisitionCents" INTEGER NOT NULL DEFAULT 0,
  "retentionCents"   INTEGER NOT NULL DEFAULT 0,
  "note"             TEXT,
  "updatedById"      TEXT,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,
  CONSTRAINT "marketing_spend_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "marketing_spend_conceptId_month_key" ON "marketing_spend" ("conceptId", "month");
CREATE INDEX IF NOT EXISTS "marketing_spend_tenantId_idx" ON "marketing_spend" ("tenantId");
CREATE INDEX IF NOT EXISTS "marketing_spend_conceptId_month_idx" ON "marketing_spend" ("conceptId", "month");

-- ── RLS — match the tenant-scoped pattern from the phase-4 rollout ───────────
-- The helper functions (app_is_service_mode, app_has_any_tenant, app_tenant_ids)
-- were created in 20260603071500_enable_rls_phase2. Workers/webhooks run in
-- service mode and pass through; staff requests are scoped to their tenant(s).
ALTER TABLE "marketing_spend" ENABLE ROW LEVEL SECURITY;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = current_schema() AND tablename = 'marketing_spend'
  ) THEN
    CREATE POLICY "marketing_spend_rls" ON "marketing_spend"
      FOR ALL
      USING (
        app_is_service_mode()
        OR ("tenantId" IS NULL AND app_has_any_tenant())
        OR "tenantId" = ANY(app_tenant_ids())
      )
      WITH CHECK (
        app_is_service_mode()
        OR ("tenantId" IS NULL AND app_has_any_tenant())
        OR "tenantId" = ANY(app_tenant_ids())
      );
  END IF;
END
$do$;
