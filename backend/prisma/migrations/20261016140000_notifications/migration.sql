-- 20261016140000_notifications — the notification bell (owner, 2026-10-16):
-- "add a notification box in servd. mainly for Approvals, Night run reports,
-- or warnings for any unusual activity performed by any user. Notification
-- should be sent to concerned user."
--
-- One row per (recipient, event) in "staff_notifications". Advisory only: the
-- module's own row (approval item, exception flag, night-audit day) stays the
-- record. The ONE writer is backend/src/lib/staffNotify.ts.
-- "exception_flags"."notifiedAt" is the bell's claim column
-- (workers/staffNotifications.ts); existing flags are stamped as already
-- announced so a deploy never floods the CEO's bell.
--
-- Sorts after 20261016120000_night_audit.
-- Runbook: if this migration fails on deploy, run
--   prisma migrate resolve --rolled-back 20261016140000_notifications
-- in the api image before redeploying any image (P3009 blocks every image).
-- Rollback: an older image ignores the table and the column — safe.
SET lock_timeout = '10s';

CREATE TABLE "staff_notifications" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT,
  "userId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "severity" TEXT NOT NULL DEFAULT 'info',
  "title" TEXT NOT NULL,
  "body" TEXT,
  "link" TEXT,
  "entityType" TEXT,
  "entityId" TEXT,
  "actorId" TEXT,
  "dedupeKey" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "readAt" TIMESTAMP(3),
  CONSTRAINT "staff_notifications_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "staff_notifications_user_dedupe_key" ON "staff_notifications"("userId", "dedupeKey");
CREATE INDEX "staff_notifications_userId_createdAt_idx" ON "staff_notifications"("userId", "createdAt" DESC);
CREATE INDEX "staff_notifications_tenantId_createdAt_idx" ON "staff_notifications"("tenantId", "createdAt");

ALTER TABLE "staff_notifications" ADD CONSTRAINT "staff_notifications_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "staff_notifications" ADD CONSTRAINT "staff_notifications_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "exception_flags" ADD COLUMN "notifiedAt" TIMESTAMP(3);
-- Existing flags are history: they stay on the Exceptions page, never in the bell.
UPDATE "exception_flags" SET "notifiedAt" = "createdAt";

-- ─── SQL-only objects (tests/setup.ts reads this section; one statement per ';', no trailing comments)
CREATE INDEX "staff_notifications_unread_idx" ON "staff_notifications" ("userId", "createdAt" DESC) WHERE "readAt" IS NULL;
ALTER TABLE "staff_notifications" ADD CONSTRAINT "staff_notifications_link_chk" CHECK ("link" IS NULL OR "link" ~ '^/[^/\\]');
ALTER TABLE "staff_notifications" ADD CONSTRAINT "staff_notifications_severity_chk" CHECK ("severity" IN ('info', 'success', 'warning', 'critical'));
ALTER TABLE "staff_notifications" ADD CONSTRAINT "staff_notifications_len_chk" CHECK (length("title") <= 140 AND ("body" IS NULL OR length("body") <= 500) AND length("dedupeKey") <= 200);
CREATE INDEX "exception_flags_unnotified_idx" ON "exception_flags" ("createdAt") WHERE "notifiedAt" IS NULL;

-- ─── Row-level security (the guarded wave-A/B pattern, as 20261016120000_night_audit)
-- A NULL-company row (a company-less approval item, CEO only) is invisible
-- through `prisma` under RLS by design: the inbox routes read through
-- serviceClient with an explicit userId wall (modules/notifications/inboxRoutes.ts).
DO $do$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'app_is_service_mode')
     AND EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'app_tenant_ids') THEN
    FOREACH t IN ARRAY ARRAY['staff_notifications']
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
