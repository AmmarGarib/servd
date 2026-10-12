-- BOOKS-06 — money columns a restaurant GROUP can outgrow go from INT4 to BIGINT.
--
-- Why: INT4 tops out at 2,147,483,647 paisa (PKR 21,474,836.47). Opening
-- balances, capital injections, loans, group payroll accruals, bulk stock
-- bills, capex, bank transfers and a corporate customer's lifetime spend all exceed
-- that in ONE amount, and the API had to refuse them (422 AMOUNT_TOO_LARGE).
-- After this migration one amount may be up to PKR 900,000,000,000.00
-- (MAX_MONEY_CENTS in backend/src/lib/money.ts).
--
-- The cast INT4 -> INT8 is a widening cast: every existing value is kept
-- exactly. No USING clause, no backfill, no data change. Defaults (0) and
-- NULLs stay as they are.
--
-- Stays INT4 on purpose: per-ticket amounts (orders, payments, the till,
-- pre-bills, tax invoices, gift cards, wallets), per-unit stock cost (PO line
-- unit cost, inventory item cost, receiving), per-person HR amounts and a
-- company's monthly contribution (tenant_contributions). Their 422 guards
-- stay. A supplier bill's NON-stock lines are still capped at INT4 in the API:
-- the ledger books them to 1210 Inventory – Food, so capital spend goes
-- through CapEx, not a bill.
--
-- Locking: INT4 -> INT8 is not binary-coercible, so each ALTER rewrites its
-- table and rebuilds its indexes under ACCESS EXCLUSIVE, and `prisma migrate
-- deploy` runs this file in one transaction (all 22 tables locked until
-- commit). entrypoint.sh runs it before the API boots, so no app traffic
-- contends. Rehearsed: 500k journal lines + 100k customers + 50k bills in
-- ~1.5 s. Temporary disk ~ the size of each rewritten table (journal_lines is
-- the largest).
--
-- lock_timeout: if anything else holds a lock on one of these tables (a
-- pg_dump/backup, a BI or psql session, a long query) the ALTER fails after
-- 15 s instead of hanging the deploy forever. SET (not SET LOCAL) inside the
-- migration's implicit transaction is reset when the session ends.
--
-- BEFORE DEPLOYING (owner): no other connections on these tables
--   SELECT pid, usename, application_name, state, query FROM pg_stat_activity
--    WHERE datname = current_database() AND pid <> pg_backend_pid();
-- and free disk greater than the size of journal_lines + customers
--   SELECT pg_size_pretty(pg_total_relation_size('journal_lines')),
--          pg_size_pretty(pg_total_relation_size('customers'));
--
-- IF THIS MIGRATION FAILS (lock timeout, disk full, …): Postgres rolls the
-- whole file back (every column stays integer), but Prisma records the
-- migration as FAILED in _prisma_migrations, and every later
-- `prisma migrate deploy` — including the PREVIOUS api image's — exits with
-- P3009, so NEITHER image boots until it is resolved. Recovery, BEFORE
-- redeploying either image:
--   docker compose run --rm api npx prisma migrate resolve --rolled-back 20261012140000_money_bigint
-- (or exec into the api container and run the same command), clear whatever
-- held the lock, then deploy again. Do NOT make entrypoint.sh auto-resolve.
--
-- Rollback after SUCCESS: redeploying the previous images is safe — their
-- `migrate deploy` sees no pending migration, the old INT client reads the
-- BIGINT values as numbers and its INT4 guards just refuse new big inputs.
-- Never write a down-migration: narrowing fails on any value above INT4.

SET lock_timeout = '15s';

-- AlterTable
ALTER TABLE "customers" ALTER COLUMN "totalSpentCents" SET DATA TYPE BIGINT;

-- AlterTable
ALTER TABLE "suppliers" ALTER COLUMN "openingBalanceCents" SET DATA TYPE BIGINT;

-- AlterTable
ALTER TABLE "purchase_orders" ALTER COLUMN "totalCents" SET DATA TYPE BIGINT;

-- AlterTable
ALTER TABLE "supplier_bills" ALTER COLUMN "subtotalCents" SET DATA TYPE BIGINT,
ALTER COLUMN "taxCents" SET DATA TYPE BIGINT,
ALTER COLUMN "totalCents" SET DATA TYPE BIGINT,
ALTER COLUMN "whtCents" SET DATA TYPE BIGINT,
ALTER COLUMN "paidCents" SET DATA TYPE BIGINT;

-- AlterTable
ALTER TABLE "supplier_bill_lines" ALTER COLUMN "unitCostCents" SET DATA TYPE BIGINT,
ALTER COLUMN "lineTotalCents" SET DATA TYPE BIGINT;

-- AlterTable
ALTER TABLE "supplier_payments" ALTER COLUMN "amountCents" SET DATA TYPE BIGINT,
ALTER COLUMN "appliedCents" SET DATA TYPE BIGINT;

-- AlterTable
ALTER TABLE "supplier_payment_applications" ALTER COLUMN "amountAppliedCents" SET DATA TYPE BIGINT;

-- AlterTable
ALTER TABLE "journal_lines" ALTER COLUMN "amountCents" SET DATA TYPE BIGINT;

-- AlterTable
ALTER TABLE "bank_statement_lines" ALTER COLUMN "amountCents" SET DATA TYPE BIGINT;

-- AlterTable
ALTER TABLE "cost_allocation_runs" ALTER COLUMN "totalAmountCents" SET DATA TYPE BIGINT;

-- AlterTable
ALTER TABLE "capex_projects" ALTER COLUMN "budgetEnvelopeCents" SET DATA TYPE BIGINT,
ALTER COLUMN "totalAskCents" SET DATA TYPE BIGINT,
ALTER COLUMN "consultantFeesCents" SET DATA TYPE BIGINT,
ALTER COLUMN "taxCents" SET DATA TYPE BIGINT;

-- AlterTable
ALTER TABLE "capex_lines" ALTER COLUMN "unitCostCents" SET DATA TYPE BIGINT,
ALTER COLUMN "quotedCents" SET DATA TYPE BIGINT,
ALTER COLUMN "negotiatedCents" SET DATA TYPE BIGINT,
ALTER COLUMN "paidCents" SET DATA TYPE BIGINT;

-- AlterTable
ALTER TABLE "capex_quotes" ALTER COLUMN "totalCents" SET DATA TYPE BIGINT;

-- AlterTable
ALTER TABLE "opex_categories" ALTER COLUMN "budgetMonthlyCents" SET DATA TYPE BIGINT;

-- AlterTable
ALTER TABLE "opex_lines" ALTER COLUMN "amountCents" SET DATA TYPE BIGINT;

-- AlterTable
ALTER TABLE "opex_payments" ALTER COLUMN "expectedCents" SET DATA TYPE BIGINT,
ALTER COLUMN "actualCents" SET DATA TYPE BIGINT;

-- AlterTable
ALTER TABLE "capex_payments" ALTER COLUMN "amountCents" SET DATA TYPE BIGINT,
ALTER COLUMN "paidAmountCents" SET DATA TYPE BIGINT;

-- AlterTable
ALTER TABLE "exception_flags" ALTER COLUMN "amountCents" SET DATA TYPE BIGINT;

-- AlterTable
ALTER TABLE "fixed_assets" ALTER COLUMN "costCents" SET DATA TYPE BIGINT,
ALTER COLUMN "salvageCents" SET DATA TYPE BIGINT,
ALTER COLUMN "disposalProceedsCents" SET DATA TYPE BIGINT;

-- AlterTable
ALTER TABLE "fixed_asset_depreciation" ALTER COLUMN "amountCents" SET DATA TYPE BIGINT;

-- AlterTable
ALTER TABLE "receivable_invoices" ALTER COLUMN "amountCents" SET DATA TYPE BIGINT,
ALTER COLUMN "taxCents" SET DATA TYPE BIGINT,
ALTER COLUMN "paidCents" SET DATA TYPE BIGINT;

-- AlterTable
ALTER TABLE "receivable_payments" ALTER COLUMN "amountCents" SET DATA TYPE BIGINT;

