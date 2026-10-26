-- Close the row-level-security gaps before live switches to a non-owner login
-- (owner F13 (a), 2026-10-26: "Fix those, then switch live to a non-owner
-- login with the lock on"). RLS-only: no table, column or data changes.
--
-- 1. The three helpers read a role-level session default of '__service__' as
--    "unset" (service mode). Postgres cannot unset a custom variable: once a
--    request's SET LOCAL ran on a pooled connection, the variable reads '' on
--    that connection for good, so a later serviceClient query there would no
--    longer be service mode and would see NOTHING. The non-owner login gets
--    `ALTER ROLE … SET app.tenant_ids = '__service__'` (and app.customer_id),
--    which the variable falls back to after every transaction. With no role
--    default (today's owner login) nullif(NULL, …) is NULL — no change.
-- 2. group_orders <-> group_order_members policies recursed (42P17): the
--    member checks now go through SECURITY DEFINER helpers that read the
--    other table as the owner (no policy re-entry).
-- 3. Every company table that had no policy gets the standard one (tenantId
--    in the request's companies, or service mode); customer_wallets and
--    fiscal_documents also let the signed-in customer read their own rows.
--    recipe_test_attempts follows its parent (recipes: any staff request).
-- 4. Brand-only policies that hid company-wide rows (conceptId NULL) now
--    decide by the row's company (OpEx lines: their category's company);
--    the servd-wide payment-gateway default row is readable by staff.
-- 5-7. Storefront checkout under the lock: a customer's own wallet
--    movements, gift-card redemptions, and reading `settings` (servd-wide
--    config, SELECT only) — each was refused or hidden in the customer's
--    request (found by the simulated month, tests/sim, under TEST_RLS=1).
--
-- Deliberately WITHOUT a policy (servd-wide / pre-auth / public storefront):
--   ingredient_masters (K1, servd-wide master), role_module_access (presets
--   are ONE servd-wide set), email_otps / staff_password_resets (pre-auth
--   sign-in flows), site_layout_versions / site_layout_stats (children of
--   site_layouts, whose policy admits any staff request; stats are counted on
--   anonymous storefront reads), waitlist_signups / waitlist_visits (public
--   servd.pk sign-ups). See backend/tests/rls/NON_OWNER_SWITCH.md.

-- ─── 1. Sentinel-aware helpers ──────────────────────────────────────────────

CREATE OR REPLACE FUNCTION app_tenant_ids() RETURNS text[]
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN nullif(current_setting('app.tenant_ids', true), '__service__') IS NULL THEN NULL
    WHEN nullif(current_setting('app.tenant_ids', true), '__service__') = ''   THEN ARRAY[]::text[]
    ELSE string_to_array(nullif(current_setting('app.tenant_ids', true), '__service__'), ',')
  END
$$;

CREATE OR REPLACE FUNCTION app_customer_id() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT nullif(nullif(current_setting('app.customer_id', true), '__service__'), '')
$$;

CREATE OR REPLACE FUNCTION app_is_service_mode() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.tenant_ids',  true), '__service__') IS NULL
     AND nullif(current_setting('app.customer_id', true), '__service__') IS NULL
$$;

-- ─── 2. Group orders without recursion ──────────────────────────────────────

-- Is this customer a member of the group? (reads members as the owner)
CREATE OR REPLACE FUNCTION app_group_order_has_member(gid text, cid text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_catalog AS $$
  SELECT cid IS NOT NULL AND EXISTS (
    SELECT 1 FROM group_order_members m WHERE m."groupOrderId" = gid AND m."customerId" = cid)
$$;

-- The company of a group (reads group_orders + concepts as the owner)
CREATE OR REPLACE FUNCTION app_group_order_tenant(gid text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_catalog AS $$
  SELECT c."tenantId" FROM group_orders g JOIN concepts c ON c.id = g."conceptId" WHERE g.id = gid
$$;

-- Is this customer the initiator of the group? (reads group_orders as the owner)
CREATE OR REPLACE FUNCTION app_group_order_initiated_by(gid text, cid text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_catalog AS $$
  SELECT cid IS NOT NULL AND EXISTS (
    SELECT 1 FROM group_orders g WHERE g.id = gid AND g."initiatorCustomerId" = cid)
$$;

DROP POLICY IF EXISTS "group_orders_rls" ON "group_orders";
CREATE POLICY "group_orders_rls" ON "group_orders"
  FOR ALL
  USING (
    app_is_service_mode()
    OR EXISTS (SELECT 1 FROM "concepts" c WHERE c.id = "group_orders"."conceptId" AND c."tenantId" = ANY(app_tenant_ids()))
    OR ("group_orders"."initiatorCustomerId" IS NOT NULL AND "group_orders"."initiatorCustomerId" = app_customer_id())
    OR app_group_order_has_member("group_orders".id, app_customer_id())
  )
  WITH CHECK (
    app_is_service_mode()
    OR EXISTS (SELECT 1 FROM "concepts" c WHERE c.id = "group_orders"."conceptId" AND c."tenantId" = ANY(app_tenant_ids()))
    OR ("group_orders"."initiatorCustomerId" IS NOT NULL AND "group_orders"."initiatorCustomerId" = app_customer_id())
    OR app_group_order_has_member("group_orders".id, app_customer_id())
  );

-- A member sees their own row, and the other members of a group they belong
-- to or started; staff see their companies' groups.
DROP POLICY IF EXISTS "group_order_members_rls" ON "group_order_members";
CREATE POLICY "group_order_members_rls" ON "group_order_members"
  FOR ALL
  USING (
    app_is_service_mode()
    OR ("group_order_members"."customerId" IS NOT NULL AND "group_order_members"."customerId" = app_customer_id())
    OR app_group_order_has_member("group_order_members"."groupOrderId", app_customer_id())
    OR app_group_order_initiated_by("group_order_members"."groupOrderId", app_customer_id())
    OR app_group_order_tenant("group_order_members"."groupOrderId") = ANY(app_tenant_ids())
  )
  WITH CHECK (
    app_is_service_mode()
    OR ("group_order_members"."customerId" IS NOT NULL AND "group_order_members"."customerId" = app_customer_id())
    OR app_group_order_initiated_by("group_order_members"."groupOrderId", app_customer_id())
    OR app_group_order_tenant("group_order_members"."groupOrderId") = ANY(app_tenant_ids())
  );

DROP POLICY IF EXISTS "group_order_items_rls" ON "group_order_items";
CREATE POLICY "group_order_items_rls" ON "group_order_items"
  FOR ALL
  USING (
    app_is_service_mode()
    OR app_group_order_has_member("group_order_items"."groupOrderId", app_customer_id())
    OR app_group_order_initiated_by("group_order_items"."groupOrderId", app_customer_id())
    OR app_group_order_tenant("group_order_items"."groupOrderId") = ANY(app_tenant_ids())
  )
  WITH CHECK (
    app_is_service_mode()
    OR app_group_order_has_member("group_order_items"."groupOrderId", app_customer_id())
    OR app_group_order_initiated_by("group_order_items"."groupOrderId", app_customer_id())
    OR app_group_order_tenant("group_order_items"."groupOrderId") = ANY(app_tenant_ids())
  );

-- ─── 3. Company tables that had no policy (the guarded wave-A/B pattern) ────
DO $do$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'app_is_service_mode')
     AND EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'app_tenant_ids') THEN
    FOREACH t IN ARRAY ARRAY[
      'bank_sms_alerts', 'bank_sms_devices',
      'cleaning_logs', 'cleaning_tasks', 'food_safety_units', 'temperature_logs',
      'fiscal_attempts', 'pos_connectors', 'terminal_charges', 'raast_receipts',
      'pre_bills', 'pre_bill_counters', 'tax_invoice_series',
      'receivable_invoices', 'receivable_payments',
      'hr_documents', 'hr_employees', 'hr_form_definitions', 'hr_letter_templates',
      'hr_org_units', 'hr_payroll_runs', 'hr_payslips', 'hr_records', 'hr_work_locations'
    ]
    LOOP
      IF to_regclass(t) IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename = t) THEN
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format(
          'CREATE POLICY %I ON %I FOR ALL '
          'USING (app_is_service_mode() OR %I."tenantId" = ANY(app_tenant_ids())) '
          'WITH CHECK (app_is_service_mode() OR %I."tenantId" = ANY(app_tenant_ids()))',
          t || '_rls', t, t, t);
      END IF;
    END LOOP;

    -- A customer's own wallets (one per company) on the storefront.
    IF to_regclass('customer_wallets') IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename = 'customer_wallets') THEN
      ALTER TABLE "customer_wallets" ENABLE ROW LEVEL SECURITY;
      CREATE POLICY "customer_wallets_rls" ON "customer_wallets" FOR ALL
        USING (app_is_service_mode() OR "customer_wallets"."tenantId" = ANY(app_tenant_ids())
               OR "customer_wallets"."customerId" = app_customer_id())
        WITH CHECK (app_is_service_mode() OR "customer_wallets"."tenantId" = ANY(app_tenant_ids())
               OR "customer_wallets"."customerId" = app_customer_id());
    END IF;

    -- The fiscal document of a customer's own order (receipt / invoice pages).
    IF to_regclass('fiscal_documents') IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename = 'fiscal_documents') THEN
      ALTER TABLE "fiscal_documents" ENABLE ROW LEVEL SECURITY;
      CREATE POLICY "fiscal_documents_rls" ON "fiscal_documents" FOR ALL
        USING (app_is_service_mode() OR "fiscal_documents"."tenantId" = ANY(app_tenant_ids())
               OR ("fiscal_documents"."orderId" IS NOT NULL AND EXISTS (
                 SELECT 1 FROM "orders" o WHERE o.id = "fiscal_documents"."orderId"
                   AND o."customerId" IS NOT NULL AND o."customerId" = app_customer_id())))
        WITH CHECK (app_is_service_mode() OR "fiscal_documents"."tenantId" = ANY(app_tenant_ids()));
    END IF;

    -- Recipe tasting attempts follow their recipe (recipes_rls: any staff request).
    IF to_regclass('recipe_test_attempts') IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename = 'recipe_test_attempts') THEN
      ALTER TABLE "recipe_test_attempts" ENABLE ROW LEVEL SECURITY;
      CREATE POLICY "recipe_test_attempts_rls" ON "recipe_test_attempts" FOR ALL
        USING (app_is_service_mode() OR app_has_any_tenant())
        WITH CHECK (app_is_service_mode() OR app_has_any_tenant());
    END IF;
  END IF;
END
$do$;

-- ─── 4. Brand-only policies that hid company-wide rows ──────────────────────
-- These tables carry a nullable conceptId ("all brands" / company-wide rows)
-- but their policy only matched through the brand, so under the lock a
-- company-wide row was invisible and could not be written (e.g. an OpEx line
-- with no brand: 42501). The row's own company decides; the brand is the
-- fallback only for a legacy row with no company (chained, never OR'd).

DO $do$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'content_events', 'deposit_drops', 'exception_flags', 'notification_templates',
    'petty_cash_boxes', 'scheduled_reports', 'staff_meals'
  ]
  LOOP
    IF to_regclass(t) IS NOT NULL THEN
      EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_rls', t);
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
      EXECUTE format(
        'CREATE POLICY %I ON %I FOR ALL '
        'USING (app_is_service_mode() OR coalesce(%I."tenantId", (SELECT c."tenantId" FROM concepts c WHERE c.id = %I."conceptId")) = ANY(app_tenant_ids())) '
        'WITH CHECK (app_is_service_mode() OR coalesce(%I."tenantId", (SELECT c."tenantId" FROM concepts c WHERE c.id = %I."conceptId")) = ANY(app_tenant_ids()))',
        t || '_rls', t, t, t, t, t);
    END IF;
  END LOOP;
END
$do$;

-- OpEx lines have no tenantId: the CATEGORY's company decides (a line binds
-- to its category's company), else its brand's.
DROP POLICY IF EXISTS "opex_lines_rls" ON "opex_lines";
CREATE POLICY "opex_lines_rls" ON "opex_lines"
  FOR ALL
  USING (
    app_is_service_mode()
    OR coalesce(
         (SELECT oc."tenantId" FROM "opex_categories" oc WHERE oc.id = "opex_lines"."categoryId"),
         (SELECT c."tenantId" FROM "concepts" c WHERE c.id = "opex_lines"."conceptId")
       ) = ANY(app_tenant_ids())
  )
  WITH CHECK (
    app_is_service_mode()
    OR coalesce(
         (SELECT oc."tenantId" FROM "opex_categories" oc WHERE oc.id = "opex_lines"."categoryId"),
         (SELECT c."tenantId" FROM "concepts" c WHERE c.id = "opex_lines"."conceptId")
       ) = ANY(app_tenant_ids())
  );

-- Payment gateway config: conceptId NULL is the servd-wide default row
-- (schema: "null = global"); staff routes read it beside a brand override.
DROP POLICY IF EXISTS "payment_gateway_configs_rls" ON "payment_gateway_configs";
CREATE POLICY "payment_gateway_configs_rls" ON "payment_gateway_configs"
  FOR ALL
  USING (
    app_is_service_mode()
    OR ("payment_gateway_configs"."conceptId" IS NULL AND app_has_any_tenant())
    OR EXISTS (SELECT 1 FROM "concepts" c WHERE c.id = "payment_gateway_configs"."conceptId" AND c."tenantId" = ANY(app_tenant_ids()))
  )
  WITH CHECK (
    app_is_service_mode()
    OR ("payment_gateway_configs"."conceptId" IS NULL AND app_has_any_tenant())
    OR EXISTS (SELECT 1 FROM "concepts" c WHERE c.id = "payment_gateway_configs"."conceptId" AND c."tenantId" = ANY(app_tenant_ids()))
  );

-- ─── 5. A customer's own wallet movements ───────────────────────────────────
-- Paying with the wallet at storefront checkout writes the debit in the
-- CUSTOMER's request (no company), before the order row links it — the old
-- policy only admitted a customer through orderId, so the debit was refused
-- (42501) and checkout answered 500. The row carries its customer.
DROP POLICY IF EXISTS "wallet_transactions_rls" ON "wallet_transactions";
CREATE POLICY "wallet_transactions_rls" ON "wallet_transactions"
  FOR ALL
  USING (
    app_is_service_mode()
    OR app_has_any_tenant()
    OR ("wallet_transactions"."customerId" IS NOT NULL AND "wallet_transactions"."customerId" = app_customer_id())
    OR ("wallet_transactions"."orderId" IS NOT NULL AND EXISTS (
      SELECT 1 FROM "orders" o WHERE o.id = "wallet_transactions"."orderId"
        AND o."customerId" IS NOT NULL AND o."customerId" = app_customer_id()))
  )
  WITH CHECK (
    app_is_service_mode()
    OR app_has_any_tenant()
    OR ("wallet_transactions"."customerId" IS NOT NULL AND "wallet_transactions"."customerId" = app_customer_id())
    OR ("wallet_transactions"."orderId" IS NOT NULL AND EXISTS (
      SELECT 1 FROM "orders" o WHERE o.id = "wallet_transactions"."orderId"
        AND o."customerId" IS NOT NULL AND o."customerId" = app_customer_id()))
  );

-- ─── 6. Gift cards redeemed at storefront checkout ──────────────────────────
-- The redeem (giftCards/service.ts redeemGiftCard: conditional decrement of
-- the card + a redemption row) runs in the CUSTOMER's request. Customers could
-- already read cards (by code) but not write them, so every online redemption
-- was refused (GIFT_CARD_NOT_APPLIED). WITH CHECK now mirrors USING.
DROP POLICY IF EXISTS "gift_cards_rls" ON "gift_cards";
CREATE POLICY "gift_cards_rls" ON "gift_cards"
  FOR ALL
  USING (app_is_service_mode() OR app_has_any_tenant() OR app_customer_id() IS NOT NULL)
  WITH CHECK (app_is_service_mode() OR app_has_any_tenant() OR app_customer_id() IS NOT NULL);
DROP POLICY IF EXISTS "gift_card_redemptions_rls" ON "gift_card_redemptions";
CREATE POLICY "gift_card_redemptions_rls" ON "gift_card_redemptions"
  FOR ALL
  USING (app_is_service_mode() OR app_has_any_tenant() OR app_customer_id() IS NOT NULL)
  WITH CHECK (app_is_service_mode() OR app_has_any_tenant() OR app_customer_id() IS NOT NULL);

-- ─── 7. Settings are servd-wide config, readable by every request ───────────
-- `settings` has no tenantId (per-company keys carry the company id in the
-- key). Storefront requests (a customer, or nobody signed in) read company
-- config through it — the loyalty point value, the loyalty pause, the ban
-- appeals switch — and under the lock saw no row, so a customer redeeming
-- points got the default value. Reading stays the app's decision (which key);
-- writing still needs a staff request or service mode.
DROP POLICY IF EXISTS "settings_read" ON "settings";
CREATE POLICY "settings_read" ON "settings" FOR SELECT USING (true);
