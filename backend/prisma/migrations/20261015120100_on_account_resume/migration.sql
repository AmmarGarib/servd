-- On-account clients resumed (2026-10-15; parked 2026-10-13, plan .handoff/parked/2026-10-14/plans/plan_onaccount.json).
-- Additive and instant: one nullable column and one partial unique index on a table that holds only statements of
-- on-account clients (none on live until the CEO switches on-account back on).
--   customer_accounts."lastRemindedAt" — the last statement / overdue reminder sent to the client.
--   receivable_invoices_one_statement_per_period — one live (non-void) monthly statement per client and period, so a
--     re-run of the statement worker can never issue two (SQL only; not declared in schema.prisma).
-- IF THIS MIGRATION FAILS (P3009): run in the api image
--   docker compose run --rm api npx prisma migrate resolve --rolled-back 20261015120100_on_account_resume
-- fix the cause (a lock holder, or two live statements for the same client and period — void one), then deploy again.
-- Rollback after success is safe: older images ignore the column and never write statements.
SET lock_timeout = '15s';

-- AlterTable
ALTER TABLE "customer_accounts" ADD COLUMN "lastRemindedAt" TIMESTAMP(3);

-- ─── SQL-only objects ────────────────────────────────────────────────────────
-- Applied by tests/setup.ts after `db push` straight from this file (from this marker to the end, full-line comments
-- dropped, split on ';' — no ';' inside a statement, no trailing comments).
CREATE UNIQUE INDEX "receivable_invoices_one_statement_per_period" ON "receivable_invoices" ("tenantId", "customerAccountId", "periodTo")
  WHERE "kind" = 'statement' AND "status" <> 'void';
