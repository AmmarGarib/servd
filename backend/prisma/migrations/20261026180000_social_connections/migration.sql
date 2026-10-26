-- 20261026180000_social_connections — Facebook / Instagram per brand (owner C18,
-- 2026-10-26: "Approval goes thru me, marketing can connect").
--
-- One connection per brand: Marketing connects a brand's page (pending), the CEO
-- approves it in the approvals inbox (social_connection), and only an approved
-- row is used to post. The page token is sealed through lib/secretBox.ts. The old
-- global connection (settings fb_page_*) is moved by a boot step
-- (modules/socialConnections/service.ts migrateLegacySocialConnection), not here:
-- it needs SERVD_SECRET_KEY. Nothing is dropped; the settings rows are cleared by
-- that boot step only after the token is copied.
--
-- Runbook: if this migration fails on deploy, run
--   prisma migrate resolve --rolled-back 20261026180000_social_connections
-- in the api image before redeploying any image (P3009 blocks every image).
-- Rollback: an older image reads the fb_page_* settings, which the boot step has
-- cleared — reconnect the page in the old Integrations screen after a rollback.
SET lock_timeout = '10s';

CREATE TABLE "social_connections" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT,
  "conceptId" TEXT,
  "status" TEXT NOT NULL,
  "pageId" TEXT NOT NULL,
  "pageName" TEXT,
  "igUserId" TEXT,
  "token" TEXT NOT NULL,
  "tokenHint" TEXT,
  "requestedById" TEXT,
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decidedById" TEXT,
  "decidedAt" TIMESTAMP(3),
  "decisionNote" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "social_connections_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "social_connections_tenantId_idx" ON "social_connections"("tenantId");
CREATE INDEX "social_connections_conceptId_status_idx" ON "social_connections"("conceptId", "status");

-- ─── SQL-only objects (one statement per ';', no trailing comments)
CREATE UNIQUE INDEX "social_connections_one_approved" ON "social_connections"("conceptId") WHERE "status" = 'approved';
CREATE UNIQUE INDEX "social_connections_one_pending" ON "social_connections"("conceptId") WHERE "status" = 'pending';
ALTER TABLE "social_connections" ADD CONSTRAINT "social_connections_status_chk" CHECK ("status" IN ('pending', 'approved', 'rejected', 'superseded', 'legacy'));
ALTER TABLE "social_connections" ADD CONSTRAINT "social_connections_brand_chk" CHECK (("status" = 'legacy') OR ("tenantId" IS NOT NULL AND "conceptId" IS NOT NULL));

-- ─── Row-level security (the guarded wave-A/B pattern, as 20261021100000_shift_corrections).
-- The legacy row (tenantId NULL) is read only in service mode.
DO $do$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'app_is_service_mode')
     AND EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'app_tenant_ids') THEN
    FOREACH t IN ARRAY ARRAY['social_connections']
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
