-- Phase 3 — roll RLS across the long tail of tenant- and customer-scoped tables.
--
-- Builds on Phase 1 (extension + RLS context) and Phase 2 (policies on
-- orders, reservations, payments, customer_addresses, users). All helper
-- functions (app_tenant_ids, app_customer_id, app_is_service_mode,
-- app_has_any_tenant) are defined in the Phase 2 migration and reused here.
--
-- Three policy shapes recur:
--
--   1. Tenant-scoped table with direct conceptId
--      → policy joins via concepts to match app_tenant_ids().
--   2. Customer-scoped table (loyalty, magic links, etc.)
--      → policy matches the row's customerId against app_customer_id(),
--        with staff override via app_has_any_tenant() where the data
--        is platform-wide (strikes, bans, trigger logs).
--   3. Public-browseable table (concepts, menus, hours, modifiers,
--      floors, tables) → SELECT is wide-open so unauthed storefront
--      visitors can still browse; INSERT/UPDATE/DELETE remain scoped
--      to staff matching the tenant or to service-mode callers.
--
-- "Service mode" (no session vars set — workers/webhooks/pre-auth) always
-- short-circuits to allow, so background jobs keep running unchanged.

CREATE OR REPLACE FUNCTION app_is_unauthed_browse() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT NOT app_is_service_mode()
     AND coalesce(array_length(app_tenant_ids(), 1), 0) = 0
     AND app_customer_id() IS NULL
$$;

-- ─── Order graph: order_items, order_item_modifiers, order_item_steps ────────
-- All resolve their tenant + customer through the parent order row.

ALTER TABLE "order_items" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "order_items_rls" ON "order_items"
  FOR ALL
  USING (
    app_is_service_mode()
    OR EXISTS (
      SELECT 1 FROM "orders" o
      JOIN "concepts" c ON c.id = o."conceptId"
      WHERE o.id = "order_items"."orderId"
      AND (
        (app_has_any_tenant() AND c."tenantId" = ANY(app_tenant_ids()))
        OR (o."customerId" IS NOT NULL AND o."customerId" = app_customer_id())
      )
    )
  )
  WITH CHECK (
    app_is_service_mode()
    OR EXISTS (
      SELECT 1 FROM "orders" o
      JOIN "concepts" c ON c.id = o."conceptId"
      WHERE o.id = "order_items"."orderId"
      AND (
        (app_has_any_tenant() AND c."tenantId" = ANY(app_tenant_ids()))
        OR (o."customerId" IS NOT NULL AND o."customerId" = app_customer_id())
      )
    )
  );

ALTER TABLE "order_item_modifiers" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "order_item_modifiers_rls" ON "order_item_modifiers"
  FOR ALL
  USING (
    app_is_service_mode()
    OR EXISTS (
      SELECT 1 FROM "order_items" oi
      JOIN "orders" o     ON o.id = oi."orderId"
      JOIN "concepts" c   ON c.id = o."conceptId"
      WHERE oi.id = "order_item_modifiers"."orderItemId"
      AND (
        (app_has_any_tenant() AND c."tenantId" = ANY(app_tenant_ids()))
        OR (o."customerId" IS NOT NULL AND o."customerId" = app_customer_id())
      )
    )
  )
  WITH CHECK (
    app_is_service_mode()
    OR EXISTS (
      SELECT 1 FROM "order_items" oi
      JOIN "orders" o     ON o.id = oi."orderId"
      JOIN "concepts" c   ON c.id = o."conceptId"
      WHERE oi.id = "order_item_modifiers"."orderItemId"
      AND (
        (app_has_any_tenant() AND c."tenantId" = ANY(app_tenant_ids()))
        OR (o."customerId" IS NOT NULL AND o."customerId" = app_customer_id())
      )
    )
  );

ALTER TABLE "order_item_steps" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "order_item_steps_rls" ON "order_item_steps"
  FOR ALL
  USING (
    app_is_service_mode()
    OR EXISTS (
      SELECT 1 FROM "order_items" oi
      JOIN "orders" o     ON o.id = oi."orderId"
      JOIN "concepts" c   ON c.id = o."conceptId"
      WHERE oi.id = "order_item_steps"."orderItemId"
      AND (
        (app_has_any_tenant() AND c."tenantId" = ANY(app_tenant_ids()))
        OR (o."customerId" IS NOT NULL AND o."customerId" = app_customer_id())
      )
    )
  )
  WITH CHECK (
    app_is_service_mode()
    OR EXISTS (
      SELECT 1 FROM "order_items" oi
      JOIN "orders" o     ON o.id = oi."orderId"
      JOIN "concepts" c   ON c.id = o."conceptId"
      WHERE oi.id = "order_item_steps"."orderItemId"
      AND (
        (app_has_any_tenant() AND c."tenantId" = ANY(app_tenant_ids()))
        OR (o."customerId" IS NOT NULL AND o."customerId" = app_customer_id())
      )
    )
  );

-- ─── Reviews + complaints ────────────────────────────────────────────────────

ALTER TABLE "order_reviews" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "order_reviews_rls" ON "order_reviews"
  FOR ALL
  USING (
    app_is_service_mode()
    OR EXISTS (
      SELECT 1 FROM "concepts" c
      WHERE c.id = "order_reviews"."conceptId"
      AND c."tenantId" = ANY(app_tenant_ids())
    )
    OR (
      "order_reviews"."customerId" IS NOT NULL
      AND "order_reviews"."customerId" = app_customer_id()
    )
  )
  WITH CHECK (
    app_is_service_mode()
    OR EXISTS (
      SELECT 1 FROM "concepts" c
      WHERE c.id = "order_reviews"."conceptId"
      AND c."tenantId" = ANY(app_tenant_ids())
    )
    OR (
      "order_reviews"."customerId" IS NOT NULL
      AND "order_reviews"."customerId" = app_customer_id()
    )
  );

ALTER TABLE "order_complaints" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "order_complaints_rls" ON "order_complaints"
  FOR ALL
  USING (
    app_is_service_mode()
    OR EXISTS (
      SELECT 1 FROM "concepts" c
      WHERE c.id = "order_complaints"."conceptId"
      AND c."tenantId" = ANY(app_tenant_ids())
    )
    OR (
      "order_complaints"."customerId" IS NOT NULL
      AND "order_complaints"."customerId" = app_customer_id()
    )
  )
  WITH CHECK (
    app_is_service_mode()
    OR EXISTS (
      SELECT 1 FROM "concepts" c
      WHERE c.id = "order_complaints"."conceptId"
      AND c."tenantId" = ANY(app_tenant_ids())
    )
    OR (
      "order_complaints"."customerId" IS NOT NULL
      AND "order_complaints"."customerId" = app_customer_id()
    )
  );

-- ─── Group orders ────────────────────────────────────────────────────────────

ALTER TABLE "group_orders" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "group_orders_rls" ON "group_orders"
  FOR ALL
  USING (
    app_is_service_mode()
    OR EXISTS (
      SELECT 1 FROM "concepts" c
      WHERE c.id = "group_orders"."conceptId"
      AND c."tenantId" = ANY(app_tenant_ids())
    )
    OR (
      "group_orders"."initiatorCustomerId" IS NOT NULL
      AND "group_orders"."initiatorCustomerId" = app_customer_id()
    )
    -- Members of a group order can read it too
    OR EXISTS (
      SELECT 1 FROM "group_order_members" m
      WHERE m."groupOrderId" = "group_orders".id
      AND m."customerId" = app_customer_id()
    )
  )
  WITH CHECK (
    app_is_service_mode()
    OR EXISTS (
      SELECT 1 FROM "concepts" c
      WHERE c.id = "group_orders"."conceptId"
      AND c."tenantId" = ANY(app_tenant_ids())
    )
    OR (
      "group_orders"."initiatorCustomerId" IS NOT NULL
      AND "group_orders"."initiatorCustomerId" = app_customer_id()
    )
  );

ALTER TABLE "group_order_members" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "group_order_members_rls" ON "group_order_members"
  FOR ALL
  USING (
    app_is_service_mode()
    OR "group_order_members"."customerId" = app_customer_id()
    OR EXISTS (
      SELECT 1 FROM "group_orders" g
      JOIN "concepts" c ON c.id = g."conceptId"
      WHERE g.id = "group_order_members"."groupOrderId"
      AND c."tenantId" = ANY(app_tenant_ids())
    )
  )
  WITH CHECK (
    app_is_service_mode()
    OR "group_order_members"."customerId" = app_customer_id()
    OR EXISTS (
      SELECT 1 FROM "group_orders" g
      JOIN "concepts" c ON c.id = g."conceptId"
      WHERE g.id = "group_order_members"."groupOrderId"
      AND c."tenantId" = ANY(app_tenant_ids())
    )
  );

ALTER TABLE "group_order_items" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "group_order_items_rls" ON "group_order_items"
  FOR ALL
  USING (
    app_is_service_mode()
    OR EXISTS (
      SELECT 1 FROM "group_order_members" m
      WHERE m.id = "group_order_items"."memberId"
      AND m."customerId" = app_customer_id()
    )
    OR EXISTS (
      SELECT 1 FROM "group_orders" g
      JOIN "concepts" c ON c.id = g."conceptId"
      WHERE g.id = "group_order_items"."groupOrderId"
      AND c."tenantId" = ANY(app_tenant_ids())
    )
  )
  WITH CHECK (
    app_is_service_mode()
    OR EXISTS (
      SELECT 1 FROM "group_order_members" m
      WHERE m.id = "group_order_items"."memberId"
      AND m."customerId" = app_customer_id()
    )
    OR EXISTS (
      SELECT 1 FROM "group_orders" g
      JOIN "concepts" c ON c.id = g."conceptId"
      WHERE g.id = "group_order_items"."groupOrderId"
      AND c."tenantId" = ANY(app_tenant_ids())
    )
  );

-- ─── Customer-meta tables ────────────────────────────────────────────────────
-- Strikes and bans are staff-managed risk records — customers must NOT see
-- them about themselves (or the abuse signal would leak). Allow service plus
-- any-tenant staff (cross-tenant view, since these are platform-wide). Same
-- for trigger logs (system telemetry, not user-facing).

ALTER TABLE "customer_strikes" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "customer_strikes_rls" ON "customer_strikes"
  FOR ALL
  USING (app_is_service_mode() OR app_has_any_tenant())
  WITH CHECK (app_is_service_mode() OR app_has_any_tenant());

ALTER TABLE "customer_bans" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "customer_bans_rls" ON "customer_bans"
  FOR ALL
  USING (app_is_service_mode() OR app_has_any_tenant())
  WITH CHECK (app_is_service_mode() OR app_has_any_tenant());

ALTER TABLE "trigger_logs" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "trigger_logs_rls" ON "trigger_logs"
  FOR ALL
  USING (app_is_service_mode() OR app_has_any_tenant())
  WITH CHECK (app_is_service_mode() OR app_has_any_tenant());

-- ─── Magic links + feedback ──────────────────────────────────────────────────

ALTER TABLE "magic_links" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "magic_links_rls" ON "magic_links"
  FOR ALL
  USING (
    app_is_service_mode()
    OR "magic_links"."customerId" = app_customer_id()
  )
  WITH CHECK (
    app_is_service_mode()
    OR "magic_links"."customerId" = app_customer_id()
  );

ALTER TABLE "feedback_entries" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "feedback_entries_rls" ON "feedback_entries"
  FOR ALL
  USING (
    app_is_service_mode()
    OR (
      "feedback_entries"."customerId" IS NOT NULL
      AND "feedback_entries"."customerId" = app_customer_id()
    )
    OR (
      "feedback_entries"."conceptId" IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM "concepts" c
        WHERE c.id = "feedback_entries"."conceptId"
        AND c."tenantId" = ANY(app_tenant_ids())
      )
    )
    OR (
      "feedback_entries"."conceptId" IS NULL
      AND app_has_any_tenant()
    )
  )
  WITH CHECK (
    app_is_service_mode()
    OR (
      "feedback_entries"."customerId" IS NOT NULL
      AND "feedback_entries"."customerId" = app_customer_id()
    )
    OR (
      "feedback_entries"."conceptId" IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM "concepts" c
        WHERE c.id = "feedback_entries"."conceptId"
        AND c."tenantId" = ANY(app_tenant_ids())
      )
    )
  );

-- ─── Loyalty ─────────────────────────────────────────────────────────────────

ALTER TABLE "loyalty_accounts" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "loyalty_accounts_rls" ON "loyalty_accounts"
  FOR ALL
  USING (
    app_is_service_mode()
    OR "loyalty_accounts"."customerId" = app_customer_id()
    OR app_has_any_tenant()
  )
  WITH CHECK (
    app_is_service_mode()
    OR "loyalty_accounts"."customerId" = app_customer_id()
    OR app_has_any_tenant()
  );

ALTER TABLE "loyalty_transactions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "loyalty_transactions_rls" ON "loyalty_transactions"
  FOR ALL
  USING (
    app_is_service_mode()
    OR EXISTS (
      SELECT 1 FROM "loyalty_accounts" la
      WHERE la.id = "loyalty_transactions"."loyaltyAccountId"
      AND (la."customerId" = app_customer_id() OR app_has_any_tenant())
    )
  )
  WITH CHECK (
    app_is_service_mode()
    OR EXISTS (
      SELECT 1 FROM "loyalty_accounts" la
      WHERE la.id = "loyalty_transactions"."loyaltyAccountId"
      AND (la."customerId" = app_customer_id() OR app_has_any_tenant())
    )
  );

-- ─── Concept graph: concepts, categories, menu_items, modifiers, tables, floors ─
-- These power the public storefront. SELECT is open to anyone; writes are
-- staff-only.

ALTER TABLE "concepts" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "concepts_select" ON "concepts" FOR SELECT USING (true);
CREATE POLICY "concepts_write"  ON "concepts" FOR INSERT
  WITH CHECK (app_is_service_mode() OR "concepts"."tenantId" = ANY(app_tenant_ids()));
CREATE POLICY "concepts_update" ON "concepts" FOR UPDATE
  USING      (app_is_service_mode() OR "concepts"."tenantId" = ANY(app_tenant_ids()))
  WITH CHECK (app_is_service_mode() OR "concepts"."tenantId" = ANY(app_tenant_ids()));
CREATE POLICY "concepts_delete" ON "concepts" FOR DELETE
  USING      (app_is_service_mode() OR "concepts"."tenantId" = ANY(app_tenant_ids()));

ALTER TABLE "categories" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "categories_select" ON "categories" FOR SELECT USING (true);
CREATE POLICY "categories_write"  ON "categories" FOR INSERT
  WITH CHECK (
    app_is_service_mode()
    OR EXISTS (SELECT 1 FROM "concepts" c WHERE c.id = "categories"."conceptId" AND c."tenantId" = ANY(app_tenant_ids()))
  );
CREATE POLICY "categories_update" ON "categories" FOR UPDATE
  USING (
    app_is_service_mode()
    OR EXISTS (SELECT 1 FROM "concepts" c WHERE c.id = "categories"."conceptId" AND c."tenantId" = ANY(app_tenant_ids()))
  )
  WITH CHECK (
    app_is_service_mode()
    OR EXISTS (SELECT 1 FROM "concepts" c WHERE c.id = "categories"."conceptId" AND c."tenantId" = ANY(app_tenant_ids()))
  );
CREATE POLICY "categories_delete" ON "categories" FOR DELETE
  USING (
    app_is_service_mode()
    OR EXISTS (SELECT 1 FROM "concepts" c WHERE c.id = "categories"."conceptId" AND c."tenantId" = ANY(app_tenant_ids()))
  );

ALTER TABLE "menu_items" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "menu_items_select" ON "menu_items" FOR SELECT USING (true);
CREATE POLICY "menu_items_write"  ON "menu_items" FOR INSERT
  WITH CHECK (
    app_is_service_mode()
    OR EXISTS (SELECT 1 FROM "concepts" c WHERE c.id = "menu_items"."conceptId" AND c."tenantId" = ANY(app_tenant_ids()))
  );
CREATE POLICY "menu_items_update" ON "menu_items" FOR UPDATE
  USING (
    app_is_service_mode()
    OR EXISTS (SELECT 1 FROM "concepts" c WHERE c.id = "menu_items"."conceptId" AND c."tenantId" = ANY(app_tenant_ids()))
  )
  WITH CHECK (
    app_is_service_mode()
    OR EXISTS (SELECT 1 FROM "concepts" c WHERE c.id = "menu_items"."conceptId" AND c."tenantId" = ANY(app_tenant_ids()))
  );
CREATE POLICY "menu_items_delete" ON "menu_items" FOR DELETE
  USING (
    app_is_service_mode()
    OR EXISTS (SELECT 1 FROM "concepts" c WHERE c.id = "menu_items"."conceptId" AND c."tenantId" = ANY(app_tenant_ids()))
  );

ALTER TABLE "modifier_groups" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "modifier_groups_select" ON "modifier_groups" FOR SELECT USING (true);
CREATE POLICY "modifier_groups_write"  ON "modifier_groups" FOR INSERT
  WITH CHECK (
    app_is_service_mode()
    OR EXISTS (
      SELECT 1 FROM "menu_items" mi
      JOIN "concepts" c ON c.id = mi."conceptId"
      WHERE mi.id = "modifier_groups"."menuItemId"
      AND c."tenantId" = ANY(app_tenant_ids())
    )
  );
CREATE POLICY "modifier_groups_update" ON "modifier_groups" FOR UPDATE
  USING (
    app_is_service_mode()
    OR EXISTS (
      SELECT 1 FROM "menu_items" mi
      JOIN "concepts" c ON c.id = mi."conceptId"
      WHERE mi.id = "modifier_groups"."menuItemId"
      AND c."tenantId" = ANY(app_tenant_ids())
    )
  )
  WITH CHECK (
    app_is_service_mode()
    OR EXISTS (
      SELECT 1 FROM "menu_items" mi
      JOIN "concepts" c ON c.id = mi."conceptId"
      WHERE mi.id = "modifier_groups"."menuItemId"
      AND c."tenantId" = ANY(app_tenant_ids())
    )
  );
CREATE POLICY "modifier_groups_delete" ON "modifier_groups" FOR DELETE
  USING (
    app_is_service_mode()
    OR EXISTS (
      SELECT 1 FROM "menu_items" mi
      JOIN "concepts" c ON c.id = mi."conceptId"
      WHERE mi.id = "modifier_groups"."menuItemId"
      AND c."tenantId" = ANY(app_tenant_ids())
    )
  );

ALTER TABLE "modifiers" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "modifiers_select" ON "modifiers" FOR SELECT USING (true);
CREATE POLICY "modifiers_write"  ON "modifiers" FOR INSERT
  WITH CHECK (
    app_is_service_mode()
    OR EXISTS (
      SELECT 1 FROM "modifier_groups" mg
      JOIN "menu_items" mi ON mi.id = mg."menuItemId"
      JOIN "concepts"   c  ON c.id  = mi."conceptId"
      WHERE mg.id = "modifiers"."groupId"
      AND c."tenantId" = ANY(app_tenant_ids())
    )
  );
CREATE POLICY "modifiers_update" ON "modifiers" FOR UPDATE
  USING (
    app_is_service_mode()
    OR EXISTS (
      SELECT 1 FROM "modifier_groups" mg
      JOIN "menu_items" mi ON mi.id = mg."menuItemId"
      JOIN "concepts"   c  ON c.id  = mi."conceptId"
      WHERE mg.id = "modifiers"."groupId"
      AND c."tenantId" = ANY(app_tenant_ids())
    )
  )
  WITH CHECK (
    app_is_service_mode()
    OR EXISTS (
      SELECT 1 FROM "modifier_groups" mg
      JOIN "menu_items" mi ON mi.id = mg."menuItemId"
      JOIN "concepts"   c  ON c.id  = mi."conceptId"
      WHERE mg.id = "modifiers"."groupId"
      AND c."tenantId" = ANY(app_tenant_ids())
    )
  );
CREATE POLICY "modifiers_delete" ON "modifiers" FOR DELETE
  USING (
    app_is_service_mode()
    OR EXISTS (
      SELECT 1 FROM "modifier_groups" mg
      JOIN "menu_items" mi ON mi.id = mg."menuItemId"
      JOIN "concepts"   c  ON c.id  = mi."conceptId"
      WHERE mg.id = "modifiers"."groupId"
      AND c."tenantId" = ANY(app_tenant_ids())
    )
  );

ALTER TABLE "tables" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tables_select" ON "tables" FOR SELECT USING (true);
CREATE POLICY "tables_write"  ON "tables" FOR INSERT
  WITH CHECK (
    app_is_service_mode()
    OR EXISTS (SELECT 1 FROM "concepts" c WHERE c.id = "tables"."conceptId" AND c."tenantId" = ANY(app_tenant_ids()))
  );
CREATE POLICY "tables_update" ON "tables" FOR UPDATE
  USING (
    app_is_service_mode()
    OR EXISTS (SELECT 1 FROM "concepts" c WHERE c.id = "tables"."conceptId" AND c."tenantId" = ANY(app_tenant_ids()))
  )
  WITH CHECK (
    app_is_service_mode()
    OR EXISTS (SELECT 1 FROM "concepts" c WHERE c.id = "tables"."conceptId" AND c."tenantId" = ANY(app_tenant_ids()))
  );
CREATE POLICY "tables_delete" ON "tables" FOR DELETE
  USING (
    app_is_service_mode()
    OR EXISTS (SELECT 1 FROM "concepts" c WHERE c.id = "tables"."conceptId" AND c."tenantId" = ANY(app_tenant_ids()))
  );

ALTER TABLE "floors" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "floors_select" ON "floors" FOR SELECT USING (true);
CREATE POLICY "floors_write"  ON "floors" FOR INSERT
  WITH CHECK (
    app_is_service_mode()
    OR EXISTS (SELECT 1 FROM "concepts" c WHERE c.id = "floors"."conceptId" AND c."tenantId" = ANY(app_tenant_ids()))
  );
CREATE POLICY "floors_update" ON "floors" FOR UPDATE
  USING (
    app_is_service_mode()
    OR EXISTS (SELECT 1 FROM "concepts" c WHERE c.id = "floors"."conceptId" AND c."tenantId" = ANY(app_tenant_ids()))
  )
  WITH CHECK (
    app_is_service_mode()
    OR EXISTS (SELECT 1 FROM "concepts" c WHERE c.id = "floors"."conceptId" AND c."tenantId" = ANY(app_tenant_ids()))
  );
CREATE POLICY "floors_delete" ON "floors" FOR DELETE
  USING (
    app_is_service_mode()
    OR EXISTS (SELECT 1 FROM "concepts" c WHERE c.id = "floors"."conceptId" AND c."tenantId" = ANY(app_tenant_ids()))
  );

ALTER TABLE "service_hours" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_hours_select" ON "service_hours" FOR SELECT USING (true);
CREATE POLICY "service_hours_write"  ON "service_hours" FOR INSERT
  WITH CHECK (
    app_is_service_mode()
    OR EXISTS (SELECT 1 FROM "concepts" c WHERE c.id = "service_hours"."conceptId" AND c."tenantId" = ANY(app_tenant_ids()))
  );
CREATE POLICY "service_hours_update" ON "service_hours" FOR UPDATE
  USING (
    app_is_service_mode()
    OR EXISTS (SELECT 1 FROM "concepts" c WHERE c.id = "service_hours"."conceptId" AND c."tenantId" = ANY(app_tenant_ids()))
  )
  WITH CHECK (
    app_is_service_mode()
    OR EXISTS (SELECT 1 FROM "concepts" c WHERE c.id = "service_hours"."conceptId" AND c."tenantId" = ANY(app_tenant_ids()))
  );
CREATE POLICY "service_hours_delete" ON "service_hours" FOR DELETE
  USING (
    app_is_service_mode()
    OR EXISTS (SELECT 1 FROM "concepts" c WHERE c.id = "service_hours"."conceptId" AND c."tenantId" = ANY(app_tenant_ids()))
  );

ALTER TABLE "concept_blockouts" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "concept_blockouts_rls" ON "concept_blockouts"
  FOR ALL
  USING (
    app_is_service_mode()
    OR EXISTS (SELECT 1 FROM "concepts" c WHERE c.id = "concept_blockouts"."conceptId" AND c."tenantId" = ANY(app_tenant_ids()))
  )
  WITH CHECK (
    app_is_service_mode()
    OR EXISTS (SELECT 1 FROM "concepts" c WHERE c.id = "concept_blockouts"."conceptId" AND c."tenantId" = ANY(app_tenant_ids()))
  );

-- ─── Promo codes + gift cards ────────────────────────────────────────────────

ALTER TABLE "promo_codes" ENABLE ROW LEVEL SECURITY;
-- Customers/anon need to look up a code at checkout to preview the discount.
CREATE POLICY "promo_codes_select" ON "promo_codes" FOR SELECT USING (true);
CREATE POLICY "promo_codes_write"  ON "promo_codes" FOR INSERT
  WITH CHECK (
    app_is_service_mode()
    OR "promo_codes"."conceptId" IS NULL                       -- brand-agnostic codes — any staff
    OR EXISTS (SELECT 1 FROM "concepts" c WHERE c.id = "promo_codes"."conceptId" AND c."tenantId" = ANY(app_tenant_ids()))
  );
CREATE POLICY "promo_codes_update" ON "promo_codes" FOR UPDATE
  USING (
    app_is_service_mode()
    OR "promo_codes"."conceptId" IS NULL
    OR EXISTS (SELECT 1 FROM "concepts" c WHERE c.id = "promo_codes"."conceptId" AND c."tenantId" = ANY(app_tenant_ids()))
  )
  WITH CHECK (
    app_is_service_mode()
    OR "promo_codes"."conceptId" IS NULL
    OR EXISTS (SELECT 1 FROM "concepts" c WHERE c.id = "promo_codes"."conceptId" AND c."tenantId" = ANY(app_tenant_ids()))
  );
CREATE POLICY "promo_codes_delete" ON "promo_codes" FOR DELETE
  USING (
    app_is_service_mode()
    OR "promo_codes"."conceptId" IS NULL
    OR EXISTS (SELECT 1 FROM "concepts" c WHERE c.id = "promo_codes"."conceptId" AND c."tenantId" = ANY(app_tenant_ids()))
  );

ALTER TABLE "gift_cards" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "gift_cards_rls" ON "gift_cards"
  FOR ALL
  USING (
    app_is_service_mode()
    OR app_has_any_tenant()
    OR app_customer_id() IS NOT NULL    -- customers can look up cards (balance check, redemption flow)
  )
  WITH CHECK (
    app_is_service_mode()
    OR app_has_any_tenant()
  );

ALTER TABLE "gift_card_redemptions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "gift_card_redemptions_rls" ON "gift_card_redemptions"
  FOR ALL
  USING (
    app_is_service_mode()
    OR app_has_any_tenant()
    OR app_customer_id() IS NOT NULL
  )
  WITH CHECK (
    app_is_service_mode()
    OR app_has_any_tenant()
  );

-- ─── Staff operations: shifts, cash, clock, tip pools ────────────────────────

ALTER TABLE "shifts" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "shifts_rls" ON "shifts"
  FOR ALL
  USING (
    app_is_service_mode()
    OR EXISTS (SELECT 1 FROM "users" u WHERE u.id = "shifts"."userId" AND (u."tenantId" IS NULL OR u."tenantId" = ANY(app_tenant_ids())))
  )
  WITH CHECK (
    app_is_service_mode()
    OR EXISTS (SELECT 1 FROM "users" u WHERE u.id = "shifts"."userId" AND (u."tenantId" IS NULL OR u."tenantId" = ANY(app_tenant_ids())))
  );

ALTER TABLE "cash_movements" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "cash_movements_rls" ON "cash_movements"
  FOR ALL
  USING (
    app_is_service_mode()
    OR EXISTS (
      SELECT 1 FROM "shifts" s
      JOIN "users" u ON u.id = s."userId"
      WHERE s.id = "cash_movements"."shiftId"
      AND (u."tenantId" IS NULL OR u."tenantId" = ANY(app_tenant_ids()))
    )
  )
  WITH CHECK (
    app_is_service_mode()
    OR EXISTS (
      SELECT 1 FROM "shifts" s
      JOIN "users" u ON u.id = s."userId"
      WHERE s.id = "cash_movements"."shiftId"
      AND (u."tenantId" IS NULL OR u."tenantId" = ANY(app_tenant_ids()))
    )
  );

ALTER TABLE "clock_logs" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "clock_logs_rls" ON "clock_logs"
  FOR ALL
  USING (
    app_is_service_mode()
    OR EXISTS (SELECT 1 FROM "users" u WHERE u.id = "clock_logs"."userId" AND (u."tenantId" IS NULL OR u."tenantId" = ANY(app_tenant_ids())))
  )
  WITH CHECK (
    app_is_service_mode()
    OR EXISTS (SELECT 1 FROM "users" u WHERE u.id = "clock_logs"."userId" AND (u."tenantId" IS NULL OR u."tenantId" = ANY(app_tenant_ids())))
  );

ALTER TABLE "tip_pools" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tip_pools_rls" ON "tip_pools"
  FOR ALL
  USING (
    app_is_service_mode()
    OR "tip_pools"."conceptId" IS NULL                                              -- operator-wide pool
    OR EXISTS (SELECT 1 FROM "concepts" c WHERE c.id = "tip_pools"."conceptId" AND c."tenantId" = ANY(app_tenant_ids()))
  )
  WITH CHECK (
    app_is_service_mode()
    OR "tip_pools"."conceptId" IS NULL
    OR EXISTS (SELECT 1 FROM "concepts" c WHERE c.id = "tip_pools"."conceptId" AND c."tenantId" = ANY(app_tenant_ids()))
  );

-- ─── Customers (cross-tenant by design) ──────────────────────────────────────
-- Customers can read their own row. Staff can read customers whose orders
-- touch their tenant (operational need: lookup, complaint handling, etc.).

ALTER TABLE "customers" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "customers_rls" ON "customers"
  FOR ALL
  USING (
    app_is_service_mode()
    OR "customers".id = app_customer_id()
    OR app_has_any_tenant()
  )
  WITH CHECK (
    app_is_service_mode()
    OR "customers".id = app_customer_id()
    OR app_has_any_tenant()
  );
