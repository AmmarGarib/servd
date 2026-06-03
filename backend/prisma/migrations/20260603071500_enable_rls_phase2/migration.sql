-- Phase 2: enable row-level security on the core tenant- and customer-scoped tables.
--
-- The Prisma extension at backend/src/lib/prisma.ts populates two Postgres
-- session vars at the start of every request-scoped query:
--
--   app.tenant_ids   — comma-joined list of tenant IDs this request can read
--                       and write. Empty string when the caller is a customer
--                       or unauthenticated. NULL when the caller is a
--                       background worker / webhook handler (those use
--                       serviceClient, which doesn't run SET).
--   app.customer_id  — UUID of the authed customer, or empty string for staff
--                       and unauthenticated; NULL for service callers.
--
-- Policies are written so the three modes look like:
--
--   SERVICE (worker/webhook/pre-auth):  both vars NULL → allow everything
--   STAFF (manager, cashier, etc.):     tenant_ids non-empty, row.tenant ∈ list
--   CUSTOMER (storefront):              customer_id non-empty, row owned by them
--
-- Enforcement is gated at the application layer by the RLS_ENFORCE env var.
-- Until it flips to "1", the extension never runs SET, so session vars stay
-- NULL and policies treat every query as service mode → no behaviour change.

-- ─── Helpers ─────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION app_tenant_ids() RETURNS text[]
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN current_setting('app.tenant_ids', true) IS NULL THEN NULL
    WHEN current_setting('app.tenant_ids', true) = ''   THEN ARRAY[]::text[]
    ELSE string_to_array(current_setting('app.tenant_ids', true), ',')
  END
$$;

CREATE OR REPLACE FUNCTION app_customer_id() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.customer_id', true), '')
$$;

CREATE OR REPLACE FUNCTION app_is_service_mode() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT current_setting('app.tenant_ids',  true) IS NULL
     AND current_setting('app.customer_id', true) IS NULL
$$;

CREATE OR REPLACE FUNCTION app_has_any_tenant() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT app_tenant_ids() IS NOT NULL
     AND coalesce(array_length(app_tenant_ids(), 1), 0) > 0
$$;

-- ─── orders ──────────────────────────────────────────────────────────────────
-- Multi-tenant: each row has a conceptId pointing at a Concept which has a
-- tenantId. Customers can see only their own orders.

ALTER TABLE "orders" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "orders_rls" ON "orders"
  FOR ALL
  USING (
    app_is_service_mode()
    OR (
      app_has_any_tenant()
      AND EXISTS (
        SELECT 1 FROM "concepts" c
        WHERE c.id = "orders"."conceptId"
        AND c."tenantId" = ANY(app_tenant_ids())
      )
    )
    OR (
      "orders"."customerId" IS NOT NULL
      AND "orders"."customerId" = app_customer_id()
    )
  )
  WITH CHECK (
    app_is_service_mode()
    OR (
      app_has_any_tenant()
      AND EXISTS (
        SELECT 1 FROM "concepts" c
        WHERE c.id = "orders"."conceptId"
        AND c."tenantId" = ANY(app_tenant_ids())
      )
    )
    OR (
      "orders"."customerId" IS NOT NULL
      AND "orders"."customerId" = app_customer_id()
    )
  );

-- ─── reservations ────────────────────────────────────────────────────────────
-- Same shape as orders: tenant via concept, customer via customerId.

ALTER TABLE "reservations" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "reservations_rls" ON "reservations"
  FOR ALL
  USING (
    app_is_service_mode()
    OR (
      app_has_any_tenant()
      AND EXISTS (
        SELECT 1 FROM "concepts" c
        WHERE c.id = "reservations"."conceptId"
        AND c."tenantId" = ANY(app_tenant_ids())
      )
    )
    OR (
      "reservations"."customerId" IS NOT NULL
      AND "reservations"."customerId" = app_customer_id()
    )
  )
  WITH CHECK (
    app_is_service_mode()
    OR (
      app_has_any_tenant()
      AND EXISTS (
        SELECT 1 FROM "concepts" c
        WHERE c.id = "reservations"."conceptId"
        AND c."tenantId" = ANY(app_tenant_ids())
      )
    )
    OR (
      "reservations"."customerId" IS NOT NULL
      AND "reservations"."customerId" = app_customer_id()
    )
  );

-- ─── payments ────────────────────────────────────────────────────────────────
-- Scoped via Order: payments inherit their order's tenant + customer.

ALTER TABLE "payments" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "payments_rls" ON "payments"
  FOR ALL
  USING (
    app_is_service_mode()
    OR EXISTS (
      SELECT 1 FROM "orders" o
      JOIN "concepts" c ON c.id = o."conceptId"
      WHERE o.id = "payments"."orderId"
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
      WHERE o.id = "payments"."orderId"
      AND (
        (app_has_any_tenant() AND c."tenantId" = ANY(app_tenant_ids()))
        OR (o."customerId" IS NOT NULL AND o."customerId" = app_customer_id())
      )
    )
  );

-- ─── customer_addresses ──────────────────────────────────────────────────────
-- Pure customer-owned. Staff can only read via service mode or when they're
-- looking up a specific customer's order delivery — that path uses serviceClient.

ALTER TABLE "customer_addresses" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "customer_addresses_rls" ON "customer_addresses"
  FOR ALL
  USING (
    app_is_service_mode()
    OR (
      "customer_addresses"."customerId" IS NOT NULL
      AND "customer_addresses"."customerId" = app_customer_id()
    )
  )
  WITH CHECK (
    app_is_service_mode()
    OR (
      "customer_addresses"."customerId" IS NOT NULL
      AND "customer_addresses"."customerId" = app_customer_id()
    )
  );

-- ─── users (staff) ───────────────────────────────────────────────────────────
-- Direct tenantId. Only staff can read/write staff records.

ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_rls" ON "users"
  FOR ALL
  USING (
    app_is_service_mode()
    OR (
      app_has_any_tenant()
      AND (
        "users"."tenantId" IS NULL                            -- legacy unscoped staff rows
        OR "users"."tenantId" = ANY(app_tenant_ids())
      )
    )
  )
  WITH CHECK (
    app_is_service_mode()
    OR (
      app_has_any_tenant()
      AND (
        "users"."tenantId" IS NULL
        OR "users"."tenantId" = ANY(app_tenant_ids())
      )
    )
  );
