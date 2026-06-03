-- Phase 4 — enable RLS on every remaining table.
--
-- After Phase 2 (5 tables) and Phase 3 (~30 tables), this closes the
-- coverage gap so the platform's data model is end-to-end RLS-protected.
-- ~120 tables added here.
--
-- Policy shape per table is chosen by FK signature:
--
--   tenant_match        — table has a direct tenantId column
--   tenant_via_concept  — table has conceptId (joins to concepts.tenantId)
--   tenant_via_supplier — table has supplierId (joins to suppliers.tenantId)
--   customer_or_staff   — table has customerId; own-customer + any-staff
--   order_chain         — table has orderId; resolves through the order
--   staff_only          — back-office: any-staff sees, no customer access
--
-- Every policy short-circuits on app_is_service_mode() first so background
-- workers and webhook handlers (which run via serviceClient and never SET
-- session vars) keep doing what they did yesterday.

-- ─── Helper functions ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION app_has_customer() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT app_customer_id() IS NOT NULL
$$;

-- ═════════════════════════════════════════════════════════════════════════════
-- Bucket: direct tenantId column
-- ═════════════════════════════════════════════════════════════════════════════

DO $do$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY[
      'compliance_violations',
      'component_par_levels',
      'departments',
      'inventory_items',
      'kitchen_payroll_runs',
      'kitchen_staff',
      'projections',
      'riders',
      'shift_bands',
      'suppliers',
      'wage_settings',
      'capex_projects',
      'capital_ledger_entries',
      'domains',
      'kds_devices',
      'opex_categories',
      'pro_formas',
      'positions'
    ])
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL '
      'USING ('
      '  app_is_service_mode() '
      '  OR (%I."tenantId" IS NULL AND app_has_any_tenant()) '
      '  OR %I."tenantId" = ANY(app_tenant_ids())'
      ') '
      'WITH CHECK ('
      '  app_is_service_mode() '
      '  OR (%I."tenantId" IS NULL AND app_has_any_tenant()) '
      '  OR %I."tenantId" = ANY(app_tenant_ids())'
      ')',
      t || '_rls', t, t, t, t, t
    );
  END LOOP;
END
$do$;

-- tenants — staff can read tenants they're a member of.
ALTER TABLE "tenants" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenants_rls ON "tenants"
  FOR ALL
  USING (
    app_is_service_mode()
    OR "tenants".id = ANY(app_tenant_ids())
  )
  WITH CHECK (
    app_is_service_mode()
    OR "tenants".id = ANY(app_tenant_ids())
  );

ALTER TABLE "tenant_members" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_members_rls ON "tenant_members"
  FOR ALL
  USING (
    app_is_service_mode()
    OR "tenant_members"."tenantId" = ANY(app_tenant_ids())
  )
  WITH CHECK (
    app_is_service_mode()
    OR "tenant_members"."tenantId" = ANY(app_tenant_ids())
  );

-- ═════════════════════════════════════════════════════════════════════════════
-- Bucket: tenant via conceptId
-- ═════════════════════════════════════════════════════════════════════════════

DO $do$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY[
      'allocation_rule_weights',
      'component_brand_uses',
      'content_events',
      'exception_flags',
      'invoice_counters',
      'notification_templates',
      'opex_lines',
      'payment_gateway_configs',
      'petty_cash_boxes',
      'projection_brand_inputs',
      'scheduled_reports',
      'section_discounts',
      'staff_meals',
      'stations',
      'concept_locations',
      'deposit_drops'
    ])
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL '
      'USING ('
      '  app_is_service_mode() '
      '  OR EXISTS ('
      '    SELECT 1 FROM "concepts" c '
      '    WHERE c.id = %I."conceptId" '
      '    AND c."tenantId" = ANY(app_tenant_ids())'
      '  )'
      ') '
      'WITH CHECK ('
      '  app_is_service_mode() '
      '  OR EXISTS ('
      '    SELECT 1 FROM "concepts" c '
      '    WHERE c.id = %I."conceptId" '
      '    AND c."tenantId" = ANY(app_tenant_ids())'
      '  )'
      ')',
      t || '_rls', t, t, t
    );
  END LOOP;
END
$do$;

-- ═════════════════════════════════════════════════════════════════════════════
-- Bucket: customer-owned (own customer OR any-staff)
-- ═════════════════════════════════════════════════════════════════════════════

DO $do$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY[
      'customer_conversations',
      'guest_tags',
      'customer_segment_memberships',
      'phone_otps'
    ])
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL '
      'USING ('
      '  app_is_service_mode() '
      '  OR app_has_any_tenant() '
      '  OR (%I."customerId" IS NOT NULL AND %I."customerId" = app_customer_id())'
      ') '
      'WITH CHECK ('
      '  app_is_service_mode() '
      '  OR app_has_any_tenant() '
      '  OR (%I."customerId" IS NOT NULL AND %I."customerId" = app_customer_id())'
      ')',
      t || '_rls', t, t, t, t, t
    );
  END LOOP;
END
$do$;

-- abandoned_carts — concept + customer
ALTER TABLE "abandoned_carts" ENABLE ROW LEVEL SECURITY;
CREATE POLICY abandoned_carts_rls ON "abandoned_carts"
  FOR ALL
  USING (
    app_is_service_mode()
    OR (
      "abandoned_carts"."customerId" IS NOT NULL
      AND "abandoned_carts"."customerId" = app_customer_id()
    )
    OR EXISTS (
      SELECT 1 FROM "concepts" c
      WHERE c.id = "abandoned_carts"."conceptId"
      AND c."tenantId" = ANY(app_tenant_ids())
    )
  )
  WITH CHECK (
    app_is_service_mode()
    OR (
      "abandoned_carts"."customerId" IS NOT NULL
      AND "abandoned_carts"."customerId" = app_customer_id()
    )
    OR EXISTS (
      SELECT 1 FROM "concepts" c
      WHERE c.id = "abandoned_carts"."conceptId"
      AND c."tenantId" = ANY(app_tenant_ids())
    )
  );

-- analytics_events — telemetry, staff-only read
ALTER TABLE "analytics_events" ENABLE ROW LEVEL SECURITY;
CREATE POLICY analytics_events_rls ON "analytics_events"
  FOR ALL
  USING (app_is_service_mode() OR app_has_any_tenant())
  WITH CHECK (app_is_service_mode() OR app_has_any_tenant());

-- customer_messages — joins via customer_conversations
ALTER TABLE "customer_messages" ENABLE ROW LEVEL SECURITY;
CREATE POLICY customer_messages_rls ON "customer_messages"
  FOR ALL
  USING (
    app_is_service_mode()
    OR app_has_any_tenant()
    OR EXISTS (
      SELECT 1 FROM "customer_conversations" cc
      WHERE cc.id = "customer_messages"."conversationId"
      AND cc."customerId" = app_customer_id()
    )
  )
  WITH CHECK (
    app_is_service_mode()
    OR app_has_any_tenant()
    OR EXISTS (
      SELECT 1 FROM "customer_conversations" cc
      WHERE cc.id = "customer_messages"."conversationId"
      AND cc."customerId" = app_customer_id()
    )
  );

-- ═════════════════════════════════════════════════════════════════════════════
-- Bucket: order-chain (orderId; own-customer via order)
-- ═════════════════════════════════════════════════════════════════════════════

DO $do$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY[
      'financial_entries',
      'promo_code_usages',
      'wallet_transactions',
      'tax_invoices'
    ])
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL '
      'USING ('
      '  app_is_service_mode() '
      '  OR app_has_any_tenant() '
      '  OR ('
      '    %I."orderId" IS NOT NULL '
      '    AND EXISTS ('
      '      SELECT 1 FROM "orders" o '
      '      WHERE o.id = %I."orderId" '
      '      AND o."customerId" IS NOT NULL '
      '      AND o."customerId" = app_customer_id()'
      '    )'
      '  )'
      ') '
      'WITH CHECK ('
      '  app_is_service_mode() '
      '  OR app_has_any_tenant() '
      '  OR ('
      '    %I."orderId" IS NOT NULL '
      '    AND EXISTS ('
      '      SELECT 1 FROM "orders" o '
      '      WHERE o.id = %I."orderId" '
      '      AND o."customerId" IS NOT NULL '
      '      AND o."customerId" = app_customer_id()'
      '    )'
      '  )'
      ')',
      t || '_rls', t, t, t, t, t
    );
  END LOOP;
END
$do$;

-- rider tables — operational, staff-only
ALTER TABLE "rider_locations" ENABLE ROW LEVEL SECURITY;
CREATE POLICY rider_locations_rls ON "rider_locations"
  FOR ALL
  USING (app_is_service_mode() OR app_has_any_tenant())
  WITH CHECK (app_is_service_mode() OR app_has_any_tenant());

ALTER TABLE "rider_ratings" ENABLE ROW LEVEL SECURITY;
CREATE POLICY rider_ratings_rls ON "rider_ratings"
  FOR ALL
  USING (app_is_service_mode() OR app_has_any_tenant())
  WITH CHECK (app_is_service_mode() OR app_has_any_tenant());

-- ═════════════════════════════════════════════════════════════════════════════
-- Bucket: supplier-scoped (staff with tenant via supplier→tenant)
-- ═════════════════════════════════════════════════════════════════════════════

DO $do$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY[
      'supplier_bills',
      'supplier_payments',
      'supplier_conversations',
      'supplier_portal_tokens',
      'purchase_orders',
      'goods_receipts'
    ])
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL '
      'USING ('
      '  app_is_service_mode() '
      '  OR EXISTS ('
      '    SELECT 1 FROM "suppliers" s '
      '    WHERE s.id = %I."supplierId" '
      '    AND (s."tenantId" IS NULL OR s."tenantId" = ANY(app_tenant_ids()))'
      '  )'
      ') '
      'WITH CHECK ('
      '  app_is_service_mode() '
      '  OR EXISTS ('
      '    SELECT 1 FROM "suppliers" s '
      '    WHERE s.id = %I."supplierId" '
      '    AND (s."tenantId" IS NULL OR s."tenantId" = ANY(app_tenant_ids()))'
      '  )'
      ')',
      t || '_rls', t, t, t
    );
  END LOOP;
END
$do$;

ALTER TABLE "item_price_history" ENABLE ROW LEVEL SECURITY;
CREATE POLICY item_price_history_rls ON "item_price_history"
  FOR ALL
  USING (app_is_service_mode() OR app_has_any_tenant())
  WITH CHECK (app_is_service_mode() OR app_has_any_tenant());

-- ═════════════════════════════════════════════════════════════════════════════
-- Bucket: staff-only catch-all (back-office + system tables)
-- ═════════════════════════════════════════════════════════════════════════════
-- These rows are never customer-visible. Any logged-in staff can read/write
-- them; customers cannot. Service mode bypasses for workers + webhooks.

DO $do$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT DISTINCT unnest(ARRAY[
      -- accounting + finance
      'accounts',
      'bank_accounts',
      'bank_statement_imports',
      'bank_statement_lines',
      'capex_lines',
      'capex_payments',
      'capex_quotes',
      'cost_allocation_rules',
      'cost_allocation_runs',
      'journal_entries',
      'journal_lines',
      'opex_payments',
      'period_locks',
      'petty_cash_movements',
      'tax_invoice_lines',
      'tenant_contributions',
      'pro_forma_channels',
      'pro_forma_fixed_costs',
      'pro_forma_months',
      -- payroll + workforce
      'payroll_runs',
      'payroll_run_lines',
      'kitchen_shifts',
      'scheduled_shifts',
      'shift_swap_requests',
      'tip_pool_members',
      -- procurement chain
      'purchase_order_lines',
      'supplier_bill_lines',
      'supplier_payment_applications',
      'supplier_messages',
      'goods_receipt_lines',
      'receiving_discrepancies',
      'physical_count_lines',
      'physical_counts',
      'po_activity_log',
      'stock_transfers',
      'waste_logs',
      'prep_batches',
      -- recipe + inventory templates
      'recipes',
      'recipe_ingredients',
      'recipe_steps',
      'components',
      'modifier_templates',
      'modifier_template_options',
      -- marketing
      'campaigns',
      'campaign_sends',
      'customer_segments',
      'segments',
      'social_posts',
      -- storefront_promos handled below with public SELECT

      -- ops / system
      'audit_logs',
      'automation_triggers',
      'custom_field_definitions',
      'custom_field_values',
      'delivery_zones',
      'expo_push_tokens',
      'locations',
      'media_assets',
      'operations_configs',
      'qr_codes',
      'receipt_configs',
      'refund_policies',
      'reservation_policies',
      'role_permissions',
      'settings',
      'site_layouts',
      'tier_configs',
      'webhook_deliveries',
      'webhook_events',
      'webhook_subscriptions'
    ])
  LOOP
    -- Skip tables that already have a policy (catches duplicates inside
    -- this array AND any cross-bucket overlap, idempotent against re-runs).
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = current_schema() AND tablename = t
    ) THEN
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
      EXECUTE format(
        'CREATE POLICY %I ON %I FOR ALL '
        'USING (app_is_service_mode() OR app_has_any_tenant()) '
        'WITH CHECK (app_is_service_mode() OR app_has_any_tenant())',
        t || '_rls', t
      );
    END IF;
  END LOOP;
END
$do$;

-- ─── storefront_promos: public SELECT for unauthed storefront strip ──────────
ALTER TABLE "storefront_promos" ENABLE ROW LEVEL SECURITY;
CREATE POLICY storefront_promos_select ON "storefront_promos" FOR SELECT USING (true);
CREATE POLICY storefront_promos_write  ON "storefront_promos" FOR INSERT
  WITH CHECK (app_is_service_mode() OR app_has_any_tenant());
CREATE POLICY storefront_promos_update ON "storefront_promos" FOR UPDATE
  USING      (app_is_service_mode() OR app_has_any_tenant())
  WITH CHECK (app_is_service_mode() OR app_has_any_tenant());
CREATE POLICY storefront_promos_delete ON "storefront_promos" FOR DELETE
  USING      (app_is_service_mode() OR app_has_any_tenant());
