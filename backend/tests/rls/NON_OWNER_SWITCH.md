# Switching live to a non-owner database login (company lock ON)

Owner F13 (a), 2026-10-26: "Fix those, then switch live to a non-owner login
with the lock on". This is the IT runbook. Nothing here has been applied to
live; live keeps its current `DATABASE_URL` until IT does the steps below.

## Why

Live connects as the table owner. Postgres never applies row-level security
to a table's owner (we do not use `FORCE ROW LEVEL SECURITY`), so every
policy is skipped and the company lock is only as good as each query's own
`where`. `RLS_ENFORCE: "1"` is already set in `deploy/docker-compose.yml`, so
the app already sends `app.tenant_ids` / `app.customer_id` on every request;
connecting as a non-owner login is the only missing piece.

## What the code now guarantees (migration `20261026140000_rls_gap_close`)

- Every table with a `tenantId` column has RLS on and a policy (the CI job
  `npm run test:rls` checks this in `tests/rls/rlsMode.test.ts`).
- The `group_orders` / `group_order_members` / `group_order_items` policies no
  longer recurse (42P17): member / initiator / company checks go through
  `SECURITY DEFINER` helpers (`app_group_order_has_member`,
  `app_group_order_initiated_by`, `app_group_order_tenant`), owned by the
  migration login, so they read the other table without re-entering a policy.
- The helpers `app_tenant_ids()`, `app_customer_id()`, `app_is_service_mode()`
  read the value `__service__` as "not set". This is what makes service mode
  (workers, boot, webhooks before they know the company) survive pooled
  connections: once a request's `SET LOCAL` ran on a connection, Postgres can
  never make the variable NULL again — it falls back to the ROLE DEFAULT. The
  app login therefore MUST carry the role defaults in step 2. Without them,
  every worker and boot step would see no rows after the first request on a
  connection.

- Brand-only policies on tables whose `conceptId` may be NULL (company-wide
  rows) now decide by the row's company: `content_events`, `deposit_drops`,
  `exception_flags`, `notification_templates`, `petty_cash_boxes`,
  `scheduled_reports`, `staff_meals`, `opex_lines` (its category's company);
  `payment_gateway_configs`' servd-wide default row is readable by staff.
- Storefront checkout works under the lock: a customer's own
  `wallet_transactions`, `gift_cards` / `gift_card_redemptions` writes, and
  `settings` readable by every request (SELECT only; servd-wide config).

Code paths fixed for the lock (they used the request's client where the
request had no, or the wrong, company): POST `/tenants` and `/tenants/mine`,
the head-office setup preview / apply and the planning contributions
(`labour-budget.ts`, `positions/contributions.ts`), `flagException`
(serviceClient — a flag carries the item's company), the bank-SMS and POS
connector webhooks and the Keenu callback (look up by secret, then scope the
request to that company), the public `/discounts/active`, loyalty postings
(`accounting/loyaltyPosting.ts`, serviceClient), the order's stock draw
(`orders/stock.ts deductInventoryForOrder`, scoped to the order's company +
its recipe owner), the GRNI line lookup (no required include of a hidden
receipt) and the City Ledger duplicate-code answer (under RLS Postgres hides
a unique violation's key, so Prisma's P2002 has no `target`).

Still weak (not blocking the switch; a follow-up): about 90 policies admit
ANY staff request of ANY company (`app_has_any_tenant()`), e.g. `accounts`,
`journal_entries`, `gift_cards`, `tax_invoices`, `locations`, `recipes`. They
lock out customers and anonymous requests, but between companies the app's
own `where` remains the only fence there. Tightening them to the row's
company is table-by-table work with a two-company RLS test each.

Tables deliberately WITHOUT a company policy (no `tenantId`; servd-wide or
pre-sign-in): `ingredient_masters` (K1 servd-wide master) and its typed prices
`ingredient_master_prices` (the one servd price, 2026-10-29),
`role_module_access` (presets are one servd-wide set), `email_otps`,
`staff_password_resets` (sign-in flows before anyone is known),
`site_layout_versions`, `site_layout_stats` (children of `site_layouts`,
whose policy admits any staff request; stats are counted on anonymous
storefront reads), `waitlist_signups`, `waitlist_visits` (public servd.pk
sign-ups), `database_backups` (the whole-database backup files, CEO only,
owner S13 2026-10-26). NOTE: the weekly backup's pg_dump must keep running as
the OWNER login (`MIGRATE_DATABASE_URL` or `BACKUP_DATABASE_URL`) — as the
non-owner login RLS would hide most rows from the dump.

## Steps (Neon)

Names below: owner login = the one in today's `DATABASE_URL` (Neon's
`neondb_owner` or similar); new login = `servd_app`. Do it on the practice
copy's Neon branch first (`deploy/sandbox/`), smoke-test, then live.

1. **Create the login** (Neon console → Roles → New role `servd_app`, or SQL
   as the owner login). It must NOT be a superuser, NOT have BYPASSRLS and
   NOT own any table:

   ```sql
   CREATE ROLE servd_app WITH LOGIN PASSWORD '<strong password>'
     NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
   ```

   (A role made in the Neon console is a member of `neon_superuser`; that
   role does NOT bypass RLS, but prefer the SQL above and check step 5.)

2. **Service-mode defaults** (required — see "What the code guarantees"):

   ```sql
   ALTER ROLE servd_app SET app.tenant_ids  = '__service__';
   ALTER ROLE servd_app SET app.customer_id = '__service__';
   ```

3. **Grants** (run as the owner login, in the app database):

   ```sql
   GRANT USAGE ON SCHEMA public TO servd_app;
   GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO servd_app;
   GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO servd_app;
   GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO servd_app;
   -- Tables / sequences / functions that later migrations create (as the owner):
   ALTER DEFAULT PRIVILEGES FOR ROLE <owner login> IN SCHEMA public
     GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO servd_app;
   ALTER DEFAULT PRIVILEGES FOR ROLE <owner login> IN SCHEMA public
     GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO servd_app;
   ALTER DEFAULT PRIVILEGES FOR ROLE <owner login> IN SCHEMA public
     GRANT EXECUTE ON FUNCTIONS TO servd_app;
   ```

4. **Box env** (`deploy/.env.production` on the Windows box; the api
   container reads it):

   ```
   MIGRATE_DATABASE_URL=<today's DATABASE_URL — the owner login>
   DATABASE_URL=<same host / db / params, user servd_app + its password>
   ```

   `backend/entrypoint.sh` runs `prisma migrate resolve` / `migrate deploy`
   with `MIGRATE_DATABASE_URL` when it is set (migrations need the owner:
   ALTER TABLE, CREATE POLICY, CREATE INDEX), and the API itself with
   `DATABASE_URL`. Unset = everything on `DATABASE_URL`, exactly as before.
   Keep the same Neon endpoint and query parameters (`sslmode`,
   `pgbouncer=true` / `connection_limit` if present) on both URLs.

   Optional soak first: set `RLS_ENFORCE: "0"` for the api in
   `deploy/docker-compose.yml` for a day. With the non-owner login and no
   enforcement every query is service mode (role defaults) — it proves the
   grants without changing what anyone sees. Then put `"1"` back.

5. **Restart and check** (`docker compose up -d api`), then:

   ```sql
   -- as servd_app: must be f / f
   SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user;
   -- every company table locked (expect 0 rows)
   SELECT c.relname FROM pg_class c
    WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
      AND EXISTS (SELECT 1 FROM information_schema.columns k
                   WHERE k.table_name = c.relname AND k.column_name = 'tenantId')
      AND NOT c.relrowsecurity;
   ```

   Smoke: `/health`; sign in as the CEO and as a cashier of each company;
   open the till, ring up and pay a ticket; storefront order + account page
   (wallet, orders); head-office screens (CEO → Head offices, planning); a
   group order; the approvals inbox; HR employees list; check the api log for
   `42501` (row violates policy) and `42P17`. Watch the workers' first runs
   (night audit settle, fiscal sweeper, notifications) — they must still see
   every company.

## Rollback

Put the owner URL back in `DATABASE_URL` (and remove `MIGRATE_DATABASE_URL`),
`docker compose up -d api`. The owner bypasses every policy, so behaviour is
exactly as before; nothing in the database has to change. The `servd_app`
login can stay (or `DROP ROLE servd_app` after `REASSIGN`/`DROP OWNED`, it owns
nothing). The migration itself never needs rolling back: under the owner its
policies are skipped and its helpers return what they returned before.

## Known remaining items

- Files still excluded from the RLS CI job are listed with their reason in
  `tests/rls/exclude.txt` — all are fixture-only (DDL in the test, synthetic
  contexts, test order); none is product behaviour.
- A new code path that runs before the company is known (a webhook, a token
  link) and reads company tables must look its token up with `serviceClient`
  and then `setRlsContext({ tenantIds: [<proven company>] })` (see
  `modules/connectors/webhookRoutes.ts`); a request with no company sees no
  company rows.
