SET lock_timeout = '10s';
-- 20261015170000_trash_bin — the Trash bin (owner, 2026-10-15).
-- Contract: backend/src/modules/trash/README.md. Sorts after 20261015160000_hr_work_locations.
--
-- 1. trash_entries + trash_copies (company-scoped, merge-repointed).
-- 2. promo_codes / cost_allocation_rules gain "deletedAt"; their per-company unique
--    becomes a partial unique over LIVE rows (SQL only — not re-declared in schema.prisma,
--    the tip-pool precedent), so a trashed code does not block re-creating it and a
--    restore that clashes answers 409 TRASH_CLASH.
-- 3. Partial indexes for the Trash's "Cancelled & voided" lists.
-- 4. Backfill: one trash_entries row per row ALREADY soft-deleted (17 models). Not
--    tenants: a soft-deleted company is a merged company and is never restorable.
--
-- If this migration fails on deploy: `prisma migrate resolve --rolled-back
-- 20261015170000_trash_bin` in the api image before redeploying any image (P3009).
-- Rollback below this release: the old image ignores "deletedAt" on promo_codes, so a
-- trashed promo would be redeemable again — hard-delete or deactivate trashed promos
-- (isActive=false is set at delete for that reason) before rolling back.

-- ── 1. Tables ──────────────────────────────────────────────────────────────
CREATE TABLE "trash_entries" (
  "id"           TEXT         NOT NULL,
  "tenantId"     TEXT,
  "entityType"   TEXT         NOT NULL,
  "entityId"     TEXT         NOT NULL,
  "conceptId"    TEXT,
  "title"        TEXT         NOT NULL,
  "subtitle"     TEXT,
  "parentType"   TEXT,
  "parentId"     TEXT,
  "reason"       TEXT,
  "deletedById"  TEXT,
  "deletedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "snapshot"     JSONB,
  "meta"         JSONB        NOT NULL DEFAULT '{}',
  "restoredAt"   TIMESTAMP(3),
  "restoredById" TEXT,
  "purgedAt"     TIMESTAMP(3),
  "purgedById"   TEXT,
  "purgeReason"  TEXT,
  "archivedAt"   TIMESTAMP(3),
  "archivedById" TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "trash_entries_pkey" PRIMARY KEY ("id"),
  -- a purged row keeps who / why; a snapshot is dropped on purge
  CONSTRAINT "trash_entries_purge_chk" CHECK ("purgedAt" IS NULL OR ("purgedById" IS NOT NULL AND "purgeReason" IS NOT NULL)),
  CONSTRAINT "trash_entries_restore_chk" CHECK ("restoredAt" IS NULL OR "purgedAt" IS NULL)
);
CREATE INDEX "trash_entries_tenantId_deletedAt_idx" ON "trash_entries"("tenantId", "deletedAt" DESC);
CREATE INDEX "trash_entries_tenantId_entityType_deletedAt_idx" ON "trash_entries"("tenantId", "entityType", "deletedAt" DESC);
CREATE INDEX "trash_entries_entityType_entityId_idx" ON "trash_entries"("entityType", "entityId");
-- One OPEN entry per thing (re-deleting after a restore makes a new row = history).
CREATE UNIQUE INDEX "trash_entries_open_key" ON "trash_entries"("entityType", "entityId")
  WHERE "restoredAt" IS NULL AND "purgedAt" IS NULL;

CREATE TABLE "trash_copies" (
  "id"            TEXT         NOT NULL,
  "tenantId"      TEXT,
  "entityType"    TEXT         NOT NULL,
  "entityId"      TEXT         NOT NULL,
  "mode"          TEXT         NOT NULL,
  "newEntityType" TEXT,
  "newEntityId"   TEXT,
  "copiedById"    TEXT         NOT NULL,
  "copiedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "trash_copies_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "trash_copies_mode_chk" CHECK ("mode" IN ('created', 'prefill'))
);
CREATE INDEX "trash_copies_tenantId_entityType_entityId_idx" ON "trash_copies"("tenantId", "entityType", "entityId");

-- ── 2. Soft delete for promo codes and allocation rules ─────────────────────
ALTER TABLE "promo_codes" ADD COLUMN "deletedAt" TIMESTAMP(3);
DROP INDEX IF EXISTS "promo_codes_tenantId_code_key";
CREATE UNIQUE INDEX "promo_codes_tenant_code_live_key" ON "promo_codes"("tenantId", "code")
  WHERE "deletedAt" IS NULL;
CREATE INDEX "promo_codes_tenantId_code_idx" ON "promo_codes"("tenantId", "code");

ALTER TABLE "cost_allocation_rules" ADD COLUMN "deletedAt" TIMESTAMP(3);
DROP INDEX IF EXISTS "cost_allocation_rules_tenantId_sourceAccountCode_key";
CREATE UNIQUE INDEX "cost_allocation_rules_tenant_source_live_key" ON "cost_allocation_rules"("tenantId", "sourceAccountCode")
  WHERE "deletedAt" IS NULL;
CREATE INDEX "cost_allocation_rules_tenantId_deletedAt_idx" ON "cost_allocation_rules"("tenantId", "deletedAt");

-- ── 3. "Cancelled & voided" list indexes ──────────────────────────────────
CREATE INDEX "orders_trash_cancelled_idx" ON "orders"("cancelledAt" DESC)
  WHERE "status" IN ('cancelled', 'rejected');
CREATE INDEX "order_items_trash_voided_idx" ON "order_items"("voidedAt" DESC)
  WHERE "status" = 'voided';

-- ── 4. Backfill entries for rows already soft-deleted ──────────────────────
-- deletedById NULL = "deleted before the Trash existed". meta.backfilled marks them.
-- Brand-anchored models take their company from the brand.
INSERT INTO "trash_entries" ("id", "tenantId", "entityType", "entityId", "conceptId", "title", "deletedAt", "meta", "updatedAt")
SELECT gen_random_uuid()::text, c."tenantId", 'brand', c."id", c."id", c."name", c."deletedAt", '{"backfilled":true,"previous":{"isActive":false}}'::jsonb, CURRENT_TIMESTAMP
  FROM "concepts" c WHERE c."deletedAt" IS NOT NULL;

INSERT INTO "trash_entries" ("id", "tenantId", "entityType", "entityId", "conceptId", "title", "deletedAt", "meta", "updatedAt")
SELECT gen_random_uuid()::text, c."tenantId", 'station', s."id", s."conceptId", s."name", s."deletedAt", '{"backfilled":true}'::jsonb, CURRENT_TIMESTAMP
  FROM "stations" s JOIN "concepts" c ON c."id" = s."conceptId" WHERE s."deletedAt" IS NOT NULL;

INSERT INTO "trash_entries" ("id", "tenantId", "entityType", "entityId", "conceptId", "title", "deletedAt", "meta", "updatedAt")
SELECT gen_random_uuid()::text, c."tenantId", 'category', x."id", x."conceptId", x."name", x."deletedAt", '{"backfilled":true}'::jsonb, CURRENT_TIMESTAMP
  FROM "categories" x JOIN "concepts" c ON c."id" = x."conceptId" WHERE x."deletedAt" IS NOT NULL;

INSERT INTO "trash_entries" ("id", "tenantId", "entityType", "entityId", "conceptId", "title", "deletedAt", "meta", "updatedAt")
SELECT gen_random_uuid()::text, c."tenantId", 'menu_item', x."id", x."conceptId", x."name", x."deletedAt", '{"backfilled":true}'::jsonb, CURRENT_TIMESTAMP
  FROM "menu_items" x JOIN "concepts" c ON c."id" = x."conceptId" WHERE x."deletedAt" IS NOT NULL;

INSERT INTO "trash_entries" ("id", "tenantId", "entityType", "entityId", "conceptId", "title", "parentType", "parentId", "deletedAt", "meta", "updatedAt")
SELECT gen_random_uuid()::text, c."tenantId", 'modifier_group', g."id", m."conceptId", g."name", 'menu_item', m."id", g."deletedAt", '{"backfilled":true}'::jsonb, CURRENT_TIMESTAMP
  FROM "modifier_groups" g JOIN "menu_items" m ON m."id" = g."menuItemId" JOIN "concepts" c ON c."id" = m."conceptId"
 WHERE g."deletedAt" IS NOT NULL;

INSERT INTO "trash_entries" ("id", "tenantId", "entityType", "entityId", "conceptId", "title", "deletedAt", "meta", "updatedAt")
SELECT gen_random_uuid()::text, c."tenantId", 'table', x."id", x."conceptId", x."label", x."deletedAt", '{"backfilled":true}'::jsonb, CURRENT_TIMESTAMP
  FROM "tables" x JOIN "concepts" c ON c."id" = x."conceptId" WHERE x."deletedAt" IS NOT NULL;

-- Floors deleted before the Trash: the tables they unlinked are not known (meta has no tableIds).
INSERT INTO "trash_entries" ("id", "tenantId", "entityType", "entityId", "conceptId", "title", "deletedAt", "meta", "updatedAt")
SELECT gen_random_uuid()::text, c."tenantId", 'floor', x."id", x."conceptId", x."name", x."deletedAt", '{"backfilled":true,"tableIds":[]}'::jsonb, CURRENT_TIMESTAMP
  FROM "floors" x JOIN "concepts" c ON c."id" = x."conceptId" WHERE x."deletedAt" IS NOT NULL;

-- Company-anchored models.
INSERT INTO "trash_entries" ("id", "tenantId", "entityType", "entityId", "title", "subtitle", "deletedAt", "meta", "updatedAt")
SELECT gen_random_uuid()::text, u."tenantId", 'login', u."id", u."name", u."email", u."deletedAt", '{"backfilled":true}'::jsonb, CURRENT_TIMESTAMP
  FROM "users" u WHERE u."deletedAt" IS NOT NULL;

INSERT INTO "trash_entries" ("id", "tenantId", "entityType", "entityId", "title", "subtitle", "deletedAt", "meta", "updatedAt")
SELECT gen_random_uuid()::text, r."tenantId", 'rider', r."id", r."name", r."phone", r."deletedAt", '{"backfilled":true}'::jsonb, CURRENT_TIMESTAMP
  FROM "riders" r WHERE r."deletedAt" IS NOT NULL;

INSERT INTO "trash_entries" ("id", "tenantId", "entityType", "entityId", "title", "deletedAt", "meta", "updatedAt")
SELECT gen_random_uuid()::text, x."tenantId", 'modifier_template', x."id", x."name", x."deletedAt", '{"backfilled":true}'::jsonb, CURRENT_TIMESTAMP
  FROM "modifier_templates" x WHERE x."deletedAt" IS NOT NULL;

INSERT INTO "trash_entries" ("id", "tenantId", "entityType", "entityId", "title", "deletedAt", "meta", "updatedAt")
SELECT gen_random_uuid()::text, x."tenantId", 'bank_account', x."id", x."name", x."deletedAt", '{"backfilled":true}'::jsonb, CURRENT_TIMESTAMP
  FROM "bank_accounts" x WHERE x."deletedAt" IS NOT NULL;

INSERT INTO "trash_entries" ("id", "tenantId", "entityType", "entityId", "title", "deletedAt", "meta", "updatedAt")
SELECT gen_random_uuid()::text, x."tenantId", 'webhook', x."id", x."url", x."deletedAt", '{"backfilled":true}'::jsonb, CURRENT_TIMESTAMP
  FROM "webhook_subscriptions" x WHERE x."deletedAt" IS NOT NULL;

INSERT INTO "trash_entries" ("id", "tenantId", "entityType", "entityId", "title", "deletedAt", "meta", "updatedAt")
SELECT gen_random_uuid()::text, x."tenantId", 'scheduled_report', x."id", x."name", x."deletedAt", '{"backfilled":true}'::jsonb, CURRENT_TIMESTAMP
  FROM "scheduled_reports" x WHERE x."deletedAt" IS NOT NULL;

INSERT INTO "trash_entries" ("id", "tenantId", "entityType", "entityId", "title", "deletedAt", "meta", "updatedAt")
SELECT gen_random_uuid()::text, x."tenantId", 'capex_project', x."id", x."name", x."deletedAt", '{"backfilled":true}'::jsonb, CURRENT_TIMESTAMP
  FROM "capex_projects" x WHERE x."deletedAt" IS NOT NULL;

INSERT INTO "trash_entries" ("id", "tenantId", "entityType", "entityId", "title", "deletedAt", "meta", "updatedAt")
SELECT gen_random_uuid()::text, x."tenantId", 'opex_category', x."id", x."name", x."deletedAt", '{"backfilled":true}'::jsonb, CURRENT_TIMESTAMP
  FROM "opex_categories" x WHERE x."deletedAt" IS NOT NULL;

INSERT INTO "trash_entries" ("id", "tenantId", "entityType", "entityId", "title", "deletedAt", "meta", "updatedAt")
SELECT gen_random_uuid()::text, x."tenantId", 'domain', x."id", x."hostname", x."deletedAt", '{"backfilled":true}'::jsonb, CURRENT_TIMESTAMP
  FROM "domains" x WHERE x."deletedAt" IS NOT NULL;

-- Locations deleted before the Trash: their brand links were deleted and are not known.
INSERT INTO "trash_entries" ("id", "tenantId", "entityType", "entityId", "title", "deletedAt", "meta", "updatedAt")
SELECT gen_random_uuid()::text, x."tenantId", 'location', x."id", x."name", x."deletedAt", '{"backfilled":true,"brandLinks":[]}'::jsonb, CURRENT_TIMESTAMP
  FROM "locations" x WHERE x."deletedAt" IS NOT NULL;

-- Status masters already in that state (dismissed exceptions, archived positions,
-- ended contributions, inactive OpEx lines) are NOT backfilled: their screens show them
-- today and "previous" is unknown. Only new deletes enter the Trash.

-- ── 5. Row-level security (the guarded wave-A/B pattern) ────────────────────
-- Company rows only; a company-less entry (servd:* pages, legacy logins) is
-- visible in service mode only — the Trash service reads entries on
-- serviceClient with its own explicit scope (CEO only for company-less rows).
DO $do$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'app_is_service_mode')
     AND EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'app_tenant_ids') THEN
    FOREACH t IN ARRAY ARRAY['trash_entries', 'trash_copies']
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
