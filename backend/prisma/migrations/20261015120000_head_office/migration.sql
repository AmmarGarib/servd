-- Head office (D1) and HOD approvals with hand-over (D3) — 2026-10-15.
-- Spec: .handoff/fixes/D1D3-spec.md §2 as changed by D1D3-amendments.json (A1 wins) and the coordinator's plan.
--
-- What it does, in order:
--   (a) enum TenantKind + tenants.kind (default 'company', every existing row is a company) and its index;
--   (b) submit-time stamp viaHeadOfficeId (plain id, no FK, no backfill) on purchase_orders, recipes, hr_records,
--       hr_payroll_runs, site_layouts and users; recipes.createdById / editedByIds;
--       tenant_contributions.category default becomes 'other' (enum unchanged, rows unchanged);
--   (c) nine new company tables: head_office_links, head_office_books, recharge_splits, recharge_split_lines,
--       recharge_runs, recharge_run_lines, approval_delegations, journal_requests, pos_connector_changes — their
--       indexes and foreign keys;
--   (d) SQL-only objects: two partial unique indexes and the CHECK constraints;
--   (e) row-level security on the new tables.
-- Additive: no backfill, no table rewrite (ADD COLUMN with a constant default or nullable), every statement is instant
-- on real data. NOT here on purpose: accounts.controlledBy (wave B already has it) and intercompany_transfers (its
-- ic_source_chk already allows 'ho_recharge' — head-office money moves through the existing inter-company engine and
-- the pair accounts 1450–1499 / 2150–2199, so there are no head-office due-to / due-from columns). Every money column
-- is BIGINT paisa (BOOKS-06).
--
-- Locking: `prisma migrate deploy` runs this file in ONE transaction before the API boots (entrypoint.sh).
-- lock_timeout: if anything else holds a lock on a touched table (a backup, a psql/BI session) the statement fails
-- after 15 s instead of hanging the deploy. SET (not SET LOCAL) is reset when the session ends.
--
-- IF THIS MIGRATION FAILS (P3009): Postgres rolls the whole file back, but Prisma records it as FAILED and every
-- later `prisma migrate deploy` — including the PREVIOUS api image's — exits with P3009, so NEITHER image boots until
-- it is resolved. BEFORE redeploying either image, run in the api image:
--   docker compose run --rm api npx prisma migrate resolve --rolled-back 20261015120000_head_office
-- fix the cause (usually a lock holder), then deploy again. Do NOT make entrypoint.sh auto-resolve.
--
-- Rollback after SUCCESS: older images ignore the new columns and tables, so rolling back is safe UNTIL a tenant of
-- kind 'head_office' exists. Once one does, NEVER roll the API image back below this release: an older Prisma client
-- throws on the unknown TenantKind value as soon as it reads that tenant.
SET lock_timeout = '15s';

-- CreateEnum
CREATE TYPE "TenantKind" AS ENUM ('company', 'head_office');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "viaHeadOfficeId" TEXT;

-- AlterTable
ALTER TABLE "recipes" ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "editedByIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "viaHeadOfficeId" TEXT;

-- AlterTable
ALTER TABLE "purchase_orders" ADD COLUMN     "viaHeadOfficeId" TEXT;

-- AlterTable
ALTER TABLE "site_layouts" ADD COLUMN     "viaHeadOfficeId" TEXT;

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "kind" "TenantKind" NOT NULL DEFAULT 'company';

-- AlterTable
ALTER TABLE "tenant_contributions" ALTER COLUMN "category" SET DEFAULT 'other';

-- AlterTable
ALTER TABLE "hr_records" ADD COLUMN     "viaHeadOfficeId" TEXT;

-- AlterTable
ALTER TABLE "hr_payroll_runs" ADD COLUMN     "viaHeadOfficeId" TEXT;

-- CreateTable
CREATE TABLE "head_office_links" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "companyTenantId" TEXT NOT NULL,
    "chargesAccountId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "lastChargedPeriod" TEXT,
    "createdById" TEXT NOT NULL,
    "endedById" TEXT,
    "endReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "head_office_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "head_office_books" (
    "tenantId" TEXT NOT NULL,
    "rechargeAccountId" TEXT,
    "costPool" JSONB NOT NULL DEFAULT '{"include":[{"from":5000,"to":6999}],"includeCodes":[],"excludeCodes":["6990"]}',
    "accountsConfirmedAt" TIMESTAMP(3),
    "accountsConfirmedById" TEXT,
    "accountsConfirmedNote" TEXT,
    "taxAnswer" TEXT,
    "rechargeEnabled" BOOLEAN NOT NULL DEFAULT false,
    "rechargeFromPeriod" TEXT,
    "requireLockedPayroll" BOOLEAN NOT NULL DEFAULT true,
    "setupAppliedAt" TIMESTAMP(3),
    "setupAppliedById" TEXT,
    "setupSummary" JSONB,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "head_office_books_pkey" PRIMARY KEY ("tenantId")
);

-- CreateTable
CREATE TABLE "recharge_splits" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "effectiveFrom" TEXT NOT NULL,
    "note" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recharge_splits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recharge_split_lines" (
    "id" TEXT NOT NULL,
    "splitId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "companyTenantId" TEXT NOT NULL,
    "shareBps" INTEGER NOT NULL,

    CONSTRAINT "recharge_split_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recharge_runs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'monthly',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "stale" BOOLEAN NOT NULL DEFAULT false,
    "splitId" TEXT NOT NULL,
    "costPool" JSONB NOT NULL,
    "basis" JSONB NOT NULL,
    "poolCents" BIGINT NOT NULL,
    "priorCents" BIGINT NOT NULL,
    "baseCents" BIGINT NOT NULL,
    "rechargedCents" BIGINT NOT NULL,
    "retainedCents" BIGINT NOT NULL,
    "driftAtApprovalCents" BIGINT,
    "warnings" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "preparedById" TEXT,
    "preparedByIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "preparedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedById" TEXT,
    "submittedAt" TIMESTAMP(3),
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "decidedVia" TEXT,
    "delegationId" TEXT,
    "postedAt" TIMESTAMP(3),
    "reversedById" TEXT,
    "reversedAt" TIMESTAMP(3),
    "reversalReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recharge_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recharge_run_lines" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "companyTenantId" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "shareBps" INTEGER NOT NULL,
    "amountCents" BIGINT NOT NULL,
    "transferId" TEXT,
    "entryDate" TIMESTAMP(3),
    "postedLate" BOOLEAN NOT NULL DEFAULT false,
    "memoNote" TEXT,

    CONSTRAINT "recharge_run_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_delegations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "companyTenantId" TEXT,
    "section" TEXT NOT NULL,
    "approvalTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "delegateUserId" TEXT NOT NULL,
    "grantedById" TEXT NOT NULL,
    "note" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endsAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,
    "revokeReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_delegations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_requests" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'post',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "description" TEXT NOT NULL,
    "reference" TEXT,
    "entryDate" TIMESTAMP(3),
    "lines" JSONB NOT NULL DEFAULT '[]',
    "totalCents" BIGINT NOT NULL DEFAULT 0,
    "reverseEntryId" TEXT,
    "reason" TEXT,
    "preparedById" TEXT NOT NULL,
    "preparedByIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "preparedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedById" TEXT,
    "submittedAt" TIMESTAMP(3),
    "viaHeadOfficeId" TEXT,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "decidedVia" TEXT,
    "delegationId" TEXT,
    "postedEntryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "journal_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pos_connector_changes" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" "ConnectorKind" NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'submitted',
    "patch" JSONB NOT NULL,
    "apiKeyEnc" TEXT,
    "webhookSecretEnc" TEXT,
    "preparedById" TEXT NOT NULL,
    "preparedByIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "preparedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "viaHeadOfficeId" TEXT,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "decidedVia" TEXT,
    "delegationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pos_connector_changes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "head_office_links_tenantId_endedAt_idx" ON "head_office_links"("tenantId", "endedAt");

-- CreateIndex
CREATE INDEX "head_office_links_companyTenantId_endedAt_idx" ON "head_office_links"("companyTenantId", "endedAt");

-- CreateIndex
CREATE UNIQUE INDEX "recharge_splits_tenantId_effectiveFrom_key" ON "recharge_splits"("tenantId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "recharge_split_lines_companyTenantId_idx" ON "recharge_split_lines"("companyTenantId");

-- CreateIndex
CREATE INDEX "recharge_split_lines_tenantId_idx" ON "recharge_split_lines"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "recharge_split_lines_splitId_companyTenantId_key" ON "recharge_split_lines"("splitId", "companyTenantId");

-- CreateIndex
CREATE INDEX "recharge_runs_tenantId_period_status_idx" ON "recharge_runs"("tenantId", "period", "status");

-- CreateIndex
CREATE INDEX "recharge_runs_status_submittedAt_idx" ON "recharge_runs"("status", "submittedAt");

-- CreateIndex
CREATE UNIQUE INDEX "recharge_run_lines_transferId_key" ON "recharge_run_lines"("transferId");

-- CreateIndex
CREATE INDEX "recharge_run_lines_companyTenantId_idx" ON "recharge_run_lines"("companyTenantId");

-- CreateIndex
CREATE INDEX "recharge_run_lines_tenantId_idx" ON "recharge_run_lines"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "recharge_run_lines_runId_companyTenantId_key" ON "recharge_run_lines"("runId", "companyTenantId");

-- CreateIndex
CREATE INDEX "approval_delegations_delegateUserId_revokedAt_idx" ON "approval_delegations"("delegateUserId", "revokedAt");

-- CreateIndex
CREATE INDEX "approval_delegations_tenantId_section_revokedAt_idx" ON "approval_delegations"("tenantId", "section", "revokedAt");

-- CreateIndex
CREATE INDEX "approval_delegations_companyTenantId_idx" ON "approval_delegations"("companyTenantId");

-- CreateIndex
CREATE UNIQUE INDEX "journal_requests_postedEntryId_key" ON "journal_requests"("postedEntryId");

-- CreateIndex
CREATE INDEX "journal_requests_tenantId_status_idx" ON "journal_requests"("tenantId", "status");

-- CreateIndex
CREATE INDEX "journal_requests_preparedById_idx" ON "journal_requests"("preparedById");

-- CreateIndex
CREATE INDEX "pos_connector_changes_tenantId_status_idx" ON "pos_connector_changes"("tenantId", "status");

-- CreateIndex
CREATE INDEX "tenants_kind_idx" ON "tenants"("kind");

-- AddForeignKey
ALTER TABLE "head_office_links" ADD CONSTRAINT "head_office_links_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "head_office_links" ADD CONSTRAINT "head_office_links_companyTenantId_fkey" FOREIGN KEY ("companyTenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "head_office_links" ADD CONSTRAINT "head_office_links_chargesAccountId_fkey" FOREIGN KEY ("chargesAccountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "head_office_books" ADD CONSTRAINT "head_office_books_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "head_office_books" ADD CONSTRAINT "head_office_books_rechargeAccountId_fkey" FOREIGN KEY ("rechargeAccountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recharge_splits" ADD CONSTRAINT "recharge_splits_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recharge_split_lines" ADD CONSTRAINT "recharge_split_lines_splitId_fkey" FOREIGN KEY ("splitId") REFERENCES "recharge_splits"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recharge_split_lines" ADD CONSTRAINT "recharge_split_lines_companyTenantId_fkey" FOREIGN KEY ("companyTenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recharge_split_lines" ADD CONSTRAINT "recharge_split_lines_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recharge_runs" ADD CONSTRAINT "recharge_runs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recharge_runs" ADD CONSTRAINT "recharge_runs_splitId_fkey" FOREIGN KEY ("splitId") REFERENCES "recharge_splits"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recharge_run_lines" ADD CONSTRAINT "recharge_run_lines_runId_fkey" FOREIGN KEY ("runId") REFERENCES "recharge_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recharge_run_lines" ADD CONSTRAINT "recharge_run_lines_companyTenantId_fkey" FOREIGN KEY ("companyTenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recharge_run_lines" ADD CONSTRAINT "recharge_run_lines_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recharge_run_lines" ADD CONSTRAINT "recharge_run_lines_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "head_office_links"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recharge_run_lines" ADD CONSTRAINT "recharge_run_lines_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "intercompany_transfers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_delegations" ADD CONSTRAINT "approval_delegations_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_delegations" ADD CONSTRAINT "approval_delegations_companyTenantId_fkey" FOREIGN KEY ("companyTenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_requests" ADD CONSTRAINT "journal_requests_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_connector_changes" ADD CONSTRAINT "pos_connector_changes_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── SQL-only objects ────────────────────────────────────────────────────────
-- Partial unique indexes and CHECK constraints that schema.prisma cannot express (each is commented on its model
-- there and never re-declared). tests/setup.ts applies this section after `db push` straight from this file: from
-- this marker to the row-level-security marker, full-line comments dropped, split on ';' — so no statement here may
-- contain a ';' or a trailing comment.

-- At most one LIVE link per (head office, company); an ended link stays for history.
CREATE UNIQUE INDEX "head_office_links_one_live" ON "head_office_links" ("tenantId", "companyTenantId")
  WHERE "endedAt" IS NULL;
-- At most one open (draft or submitted) recharge run per head office and month.
CREATE UNIQUE INDEX "recharge_runs_one_open" ON "recharge_runs" ("tenantId", "period")
  WHERE "status" IN ('draft', 'submitted');

ALTER TABLE "head_office_links" ADD CONSTRAINT "head_office_links_parties_chk"
  CHECK ("tenantId" <> "companyTenantId");
ALTER TABLE "head_office_links" ADD CONSTRAINT "head_office_links_period_chk"
  CHECK ("lastChargedPeriod" IS NULL OR "lastChargedPeriod" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');
ALTER TABLE "head_office_books" ADD CONSTRAINT "head_office_books_enable_chk"
  CHECK (NOT "rechargeEnabled" OR ("accountsConfirmedAt" IS NOT NULL AND "rechargeFromPeriod" IS NOT NULL));
ALTER TABLE "head_office_books" ADD CONSTRAINT "head_office_books_period_chk"
  CHECK ("rechargeFromPeriod" IS NULL OR "rechargeFromPeriod" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');
ALTER TABLE "recharge_splits" ADD CONSTRAINT "recharge_splits_period_chk"
  CHECK ("effectiveFrom" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');
ALTER TABLE "recharge_split_lines" ADD CONSTRAINT "recharge_split_lines_bps_chk"
  CHECK ("shareBps" BETWEEN 1 AND 10000);
ALTER TABLE "recharge_runs" ADD CONSTRAINT "recharge_runs_period_chk"
  CHECK ("period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');
ALTER TABLE "recharge_runs" ADD CONSTRAINT "recharge_runs_kind_chk"
  CHECK ("kind" IN ('monthly', 'true_up'));
ALTER TABLE "recharge_runs" ADD CONSTRAINT "recharge_runs_status_chk"
  CHECK ("status" IN ('draft', 'submitted', 'posted', 'rejected', 'withdrawn', 'reversed'));
ALTER TABLE "recharge_run_lines" ADD CONSTRAINT "recharge_run_lines_bps_chk"
  CHECK ("shareBps" BETWEEN 0 AND 10000);
ALTER TABLE "approval_delegations" ADD CONSTRAINT "approval_delegations_section_chk"
  CHECK ("section" IN ('operations', 'procurement', 'finance', 'marketing', 'hr', 'dev'));
ALTER TABLE "approval_delegations" ADD CONSTRAINT "approval_delegations_window_chk"
  CHECK ("endsAt" IS NULL OR "endsAt" > "startsAt");
ALTER TABLE "journal_requests" ADD CONSTRAINT "journal_requests_kind_chk"
  CHECK ("kind" IN ('post', 'reverse'));
ALTER TABLE "journal_requests" ADD CONSTRAINT "journal_requests_status_chk"
  CHECK ("status" IN ('draft', 'submitted', 'returned', 'posted', 'withdrawn'));
ALTER TABLE "journal_requests" ADD CONSTRAINT "journal_requests_reverse_chk"
  CHECK ("kind" <> 'reverse' OR "reverseEntryId" IS NOT NULL);
ALTER TABLE "pos_connector_changes" ADD CONSTRAINT "pos_connector_changes_status_chk"
  CHECK ("status" IN ('submitted', 'applied', 'rejected', 'withdrawn'));

-- ─── Row-level security ──────────────────────────────────────────────────────
-- The wave-A/B guarded pattern: only where the RLS helper functions exist (the test database is built with db push
-- and has none). Reach and delegation lookups run on serviceClient; route READS use the RLS client.
DO $do$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'app_is_service_mode')
     AND EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'app_tenant_ids') THEN
    -- Owned by one company (the head office, or the company whose books / connector it is).
    FOREACH t IN ARRAY ARRAY['head_office_books', 'recharge_splits', 'recharge_runs', 'journal_requests', 'pos_connector_changes']
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
    -- Two-party: the head office or the served company sees the row.
    FOREACH t IN ARRAY ARRAY['head_office_links', 'recharge_split_lines', 'recharge_run_lines', 'approval_delegations']
    LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename = t) THEN
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format(
          'CREATE POLICY %I ON %I FOR ALL '
          'USING (app_is_service_mode() OR %I."tenantId" = ANY(app_tenant_ids()) OR %I."companyTenantId" = ANY(app_tenant_ids())) '
          'WITH CHECK (app_is_service_mode() OR %I."tenantId" = ANY(app_tenant_ids()) OR %I."companyTenantId" = ANY(app_tenant_ids()))',
          t || '_rls', t, t, t, t, t);
      END IF;
    END LOOP;
  END IF;
END
$do$;
