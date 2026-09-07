-- Company scope for setup master data that had no company anchor at all.
--
-- bank_accounts, modifier_templates, webhook_subscriptions and the four
-- "singleton" config tables (refund/reservation policy, receipt/operations
-- config) were one global pool: every company saw and edited every other
-- company's rows, and a webhook registered by one company received the
-- other's order events. Each gets a tenantId; existing rows are attached to
-- the oldest active company (the primary operator) — the operator moves any
-- that belong elsewhere from the admin. The singleton tables become
-- one-global-row-per-company (unique on tenantId + scope + scopeId).

DO $$
DECLARE
  primary_tenant TEXT;
  t TEXT;
BEGIN
  SELECT id INTO primary_tenant FROM "tenants"
   WHERE "isActive" = true AND "deletedAt" IS NULL
   ORDER BY "createdAt" ASC LIMIT 1;

  FOREACH t IN ARRAY ARRAY['bank_accounts','modifier_templates','webhook_subscriptions',
                           'refund_policies','reservation_policies','receipt_configs','operations_configs']
  LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS "tenantId" TEXT', t);
    IF primary_tenant IS NOT NULL THEN
      EXECUTE format('UPDATE %I SET "tenantId" = $1 WHERE "tenantId" IS NULL', t) USING primary_tenant;
    END IF;
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I ("tenantId")', t || '_tenantId_idx', t);
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = t || '_tenantId_fkey') THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE',
                     t, t || '_tenantId_fkey');
    END IF;
  END LOOP;

  -- Singleton configs: one "global" row per company instead of one for all.
  FOREACH t IN ARRAY ARRAY['refund_policies','reservation_policies','receipt_configs','operations_configs']
  LOOP
    EXECUTE format('DROP INDEX IF EXISTS %I', t || '_scope_scopeId_key');
    EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS %I ON %I ("tenantId", "scope", "scopeId")', t || '_tenantId_scope_scopeId_key', t);
  END LOOP;
END $$;
