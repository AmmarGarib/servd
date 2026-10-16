-- 20261016120000_night_audit — the night audit (owner, 2026-10-16): "it should
-- not proceed for night run / audit until cash / card settlement / bank
-- transfers or any other payment mode is reconciled and closed … or month
-- close". One row per company per Karachi business date:
--   open → audited ("awaiting settlement", the day is LOCKED for SALES postings —
--        owner: night audit is for the sales module only)
--        → closed  (card payout + bank matched, or the CEO's override).
-- The month close's CloseCheck 'night_audit_days' needs every active day from
-- Tenant.nightAuditStartDay closed. Contract: backend/src/modules/nightAudit/README.md.
--
-- Sorts after 20261016090000_projection_calendar.
-- Runbook: if this migration fails on deploy, run
--   prisma migrate resolve --rolled-back 20261016120000_night_audit
-- in the api image before redeploying any image (P3009 blocks every image).
-- Rollback: an older image ignores the table and the column, so the day lock
-- and the month check simply stop — safe.
SET lock_timeout = '10s';

CREATE TYPE "NightAuditStatus" AS ENUM ('open', 'audited', 'closed');

CREATE TABLE "night_audit_days" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "businessDate" TEXT NOT NULL,
  "status" "NightAuditStatus" NOT NULL DEFAULT 'open',
  "auditedAt" TIMESTAMP(3),
  "auditedById" TEXT,
  "nightOverrides" JSONB,
  "nightOverrideReason" TEXT,
  "closedAt" TIMESTAMP(3),
  "closedById" TEXT,
  "closedVia" TEXT,
  "settlementOverrides" JSONB,
  "settlementOverrideReason" TEXT,
  "report" JSONB,
  "lastCheck" JSONB,
  "lastCheckedAt" TIMESTAMP(3),
  "reopenCount" INTEGER NOT NULL DEFAULT 0,
  "history" JSONB NOT NULL DEFAULT '[]',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "night_audit_days_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "night_audit_days_tenantId_businessDate_key" ON "night_audit_days"("tenantId", "businessDate");
CREATE INDEX "night_audit_days_tenantId_status_businessDate_idx" ON "night_audit_days"("tenantId", "status", "businessDate");

ALTER TABLE "night_audit_days" ADD CONSTRAINT "night_audit_days_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "tenants" ADD COLUMN "nightAuditStartDay" TEXT;

-- ─── SQL-only objects (tests/setup.ts reads this section; one statement per ';', no trailing comments)
ALTER TABLE "night_audit_days" ADD CONSTRAINT "night_audit_days_date_chk" CHECK ("businessDate" ~ '^\d{4}-\d{2}-\d{2}$');
ALTER TABLE "night_audit_days" ADD CONSTRAINT "night_audit_days_audited_chk" CHECK ("status" = 'open' OR ("auditedAt" IS NOT NULL AND "auditedById" IS NOT NULL));
ALTER TABLE "night_audit_days" ADD CONSTRAINT "night_audit_days_closed_chk" CHECK ("status" <> 'closed' OR "closedAt" IS NOT NULL);
ALTER TABLE "night_audit_days" ADD CONSTRAINT "night_audit_days_night_ovr_chk" CHECK ("nightOverrides" IS NULL OR length(btrim(coalesce("nightOverrideReason", ''))) >= 10);
ALTER TABLE "night_audit_days" ADD CONSTRAINT "night_audit_days_settle_ovr_chk" CHECK ("settlementOverrides" IS NULL OR length(btrim(coalesce("settlementOverrideReason", ''))) >= 10);
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_night_audit_start_chk" CHECK ("nightAuditStartDay" IS NULL OR "nightAuditStartDay" ~ '^\d{4}-\d{2}-\d{2}$');

-- ─── Row-level security (the guarded wave-A/B pattern, as 20261015170000_trash_bin §5)
DO $do$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'app_is_service_mode')
     AND EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'app_tenant_ids') THEN
    FOREACH t IN ARRAY ARRAY['night_audit_days']
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
