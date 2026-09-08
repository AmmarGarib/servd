-- Company scope, round three: brand-optional tables whose "All brands"
-- rows (conceptId NULL) were shared by every company, plus shifts and the
-- KDS device backfill the previous migration skipped.
--
-- delivery_zones, notification_templates, scheduled_reports: tenantId is
-- backfilled from the linked brand; brand-less rows go to the oldest active
-- company. custom_field_definitions: same, and unique becomes per company.
-- shifts: from the shift's location, else the cashier's company.
-- kds_devices: from the device's brand, else the oldest active company.

DO $$
DECLARE
  primary_tenant TEXT;
  t TEXT;
BEGIN
  SELECT id INTO primary_tenant FROM "tenants"
   WHERE "isActive" = true AND "deletedAt" IS NULL
   ORDER BY "createdAt" ASC LIMIT 1;

  FOREACH t IN ARRAY ARRAY['delivery_zones','notification_templates','scheduled_reports','custom_field_definitions','shifts']
  LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS "tenantId" TEXT', t);
  END LOOP;

  -- Brand-anchored rows: the brand's company.
  FOREACH t IN ARRAY ARRAY['delivery_zones','notification_templates','scheduled_reports','kds_devices']
  LOOP
    EXECUTE format('UPDATE %I r SET "tenantId" = c."tenantId" FROM "concepts" c WHERE r."conceptId" = c.id AND r."tenantId" IS NULL AND c."tenantId" IS NOT NULL', t);
  END LOOP;

  -- Shifts: the location's company, else the cashier's.
  UPDATE "shifts" s SET "tenantId" = l."tenantId" FROM "locations" l
   WHERE s."locationId" = l.id AND s."tenantId" IS NULL AND l."tenantId" IS NOT NULL;
  UPDATE "shifts" s SET "tenantId" = u."tenantId" FROM "users" u
   WHERE s."userId" = u.id AND s."tenantId" IS NULL AND u."tenantId" IS NOT NULL;

  -- Whatever is left (brand-less rows, legacy devices): the primary company.
  IF primary_tenant IS NOT NULL THEN
    FOREACH t IN ARRAY ARRAY['delivery_zones','notification_templates','scheduled_reports','custom_field_definitions','shifts','kds_devices']
    LOOP
      EXECUTE format('UPDATE %I SET "tenantId" = $1 WHERE "tenantId" IS NULL', t) USING primary_tenant;
    END LOOP;
  END IF;

  FOREACH t IN ARRAY ARRAY['delivery_zones','notification_templates','scheduled_reports','custom_field_definitions','shifts']
  LOOP
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I ("tenantId")', t || '_tenantId_idx', t);
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = t || '_tenantId_fkey') THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE', t, t || '_tenantId_fkey');
    END IF;
  END LOOP;

  DROP INDEX IF EXISTS "notification_templates_conceptId_channel_event_language_key";
  CREATE UNIQUE INDEX IF NOT EXISTS "notification_templates_tenant_scope_key"
    ON "notification_templates" ("tenantId", "conceptId", "channel", "event", "language");
  DROP INDEX IF EXISTS "custom_field_definitions_scope_key_key";
  CREATE UNIQUE INDEX IF NOT EXISTS "custom_field_definitions_tenantId_scope_key_key"
    ON "custom_field_definitions" ("tenantId", "scope", "key");
END $$;
