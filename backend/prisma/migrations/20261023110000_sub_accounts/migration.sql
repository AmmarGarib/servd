-- Sub-accounts (owner, 2026-10-23): "option to create sub account in chart of accounts, e.g in Wages there should be
-- option to add subaccount in name of employees … and also add option to fetch report/account statement with balance
-- of subgroups mentioned under main account".
-- A SUB-LEDGER: sub_accounts are named buckets under one account of one company; journal_line_sub_accounts tags an
-- amount of a journal line to one (the line is never changed — postings, the trial balance, the P&L, tax returns
-- and close checks read exactly what they read before). BIGINT paisa. Additive and instant (two new tables).
-- Rollback: older images ignore both tables (a reversal posted by an older image does not mirror its original's
-- tags — the sub-account statement would then show the reversed amount until tagged by hand).
SET lock_timeout = '15s';

CREATE TABLE "sub_accounts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'manual',
    "employeeId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "sub_accounts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "journal_line_sub_accounts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "journalLineId" TEXT NOT NULL,
    "subAccountId" TEXT NOT NULL,
    "amountCents" BIGINT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "journal_line_sub_accounts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "sub_accounts_tenantId_accountId_name_key" ON "sub_accounts"("tenantId", "accountId", "name");
CREATE UNIQUE INDEX "sub_accounts_accountId_employeeId_key" ON "sub_accounts"("accountId", "employeeId");
CREATE INDEX "sub_accounts_tenantId_idx" ON "sub_accounts"("tenantId");
CREATE UNIQUE INDEX "journal_line_sub_accounts_journalLineId_subAccountId_key" ON "journal_line_sub_accounts"("journalLineId", "subAccountId");
CREATE INDEX "journal_line_sub_accounts_tenantId_idx" ON "journal_line_sub_accounts"("tenantId");
CREATE INDEX "journal_line_sub_accounts_subAccountId_idx" ON "journal_line_sub_accounts"("subAccountId");

ALTER TABLE "sub_accounts" ADD CONSTRAINT "sub_accounts_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "journal_line_sub_accounts" ADD CONSTRAINT "journal_line_sub_accounts_journalLineId_fkey" FOREIGN KEY ("journalLineId") REFERENCES "journal_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "journal_line_sub_accounts" ADD CONSTRAINT "journal_line_sub_accounts_subAccountId_fkey" FOREIGN KEY ("subAccountId") REFERENCES "sub_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── SQL-only objects (tests/setup.ts applies this section; no ';' inside a statement)
ALTER TABLE "sub_accounts" ADD CONSTRAINT "sub_accounts_kind_chk"
  CHECK ("kind" IN ('manual', 'employee') AND ("kind" <> 'employee' OR "employeeId" IS NOT NULL));
ALTER TABLE "journal_line_sub_accounts" ADD CONSTRAINT "journal_line_sub_accounts_amount_chk"
  CHECK ("amountCents" > 0);
-- ─── Row-level security (the guarded wave-A/B pattern, as 20261020100000_payment_classification)
DO $do$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'app_is_service_mode')
     AND EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'app_tenant_ids') THEN
    FOREACH t IN ARRAY ARRAY['sub_accounts', 'journal_line_sub_accounts']
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
  END IF;
END
$do$;
