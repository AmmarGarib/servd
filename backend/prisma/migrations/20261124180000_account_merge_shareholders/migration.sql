-- 20261124180000_account_merge_shareholders (owner, 2026-11-24)
--   account_merges / account_merge_lines — the one-click merge of two ledger accounts ("Build one click merger"):
--     every journal line of one account re-pointed to another, each moved line recorded so it can be undone.
--   shareholders — a company's shareholders, their agreed share and the accounts holding what each put in
--     ("a page … that shows how much variance there is"). Posts nothing.
-- Nothing is dropped.
--
-- Runbook: if this migration fails on deploy, run
--   prisma migrate resolve --rolled-back 20261124180000_account_merge_shareholders
-- in the api image before redeploying any image (P3009 blocks every image).
SET lock_timeout = '10s';

CREATE TABLE "account_merges" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "fromAccountId" TEXT NOT NULL,
  "intoAccountId" TEXT NOT NULL,
  "fromCode" TEXT NOT NULL,
  "fromName" TEXT NOT NULL,
  "intoCode" TEXT NOT NULL,
  "intoName" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "requestedById" TEXT NOT NULL,
  "decidedById" TEXT,
  "decidedAt" TIMESTAMP(3),
  "decisionNote" TEXT,
  "lineCount" INTEGER NOT NULL DEFAULT 0,
  "debitCents" BIGINT NOT NULL DEFAULT 0,
  "creditCents" BIGINT NOT NULL DEFAULT 0,
  "subAccounts" JSONB,
  "appliedAt" TIMESTAMP(3),
  "undoneAt" TIMESTAMP(3),
  "undoneById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "account_merges_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "account_merges_tenantId_status_idx" ON "account_merges"("tenantId", "status");

CREATE TABLE "account_merge_lines" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "mergeId" TEXT NOT NULL,
  "journalLineId" TEXT NOT NULL,
  CONSTRAINT "account_merge_lines_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "account_merge_lines_mergeId_idx" ON "account_merge_lines"("mergeId");
CREATE INDEX "account_merge_lines_tenantId_idx" ON "account_merge_lines"("tenantId");

CREATE TABLE "shareholders" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "shareBps" INTEGER NOT NULL,
  "accountCodes" TEXT[],
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "shareholders_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "shareholders_tenantId_name_key" ON "shareholders"("tenantId", "name");
CREATE INDEX "shareholders_tenantId_idx" ON "shareholders"("tenantId");

-- ─── SQL-only objects (one statement per ';', no trailing comments)
ALTER TABLE "account_merges" ADD CONSTRAINT "account_merges_status_chk" CHECK ("status" IN ('pending', 'done', 'rejected', 'withdrawn', 'undone'));
ALTER TABLE "account_merges" ADD CONSTRAINT "account_merges_reason_chk" CHECK (char_length(btrim("reason")) >= 10);
ALTER TABLE "account_merges" ADD CONSTRAINT "account_merges_two_accounts_chk" CHECK ("fromAccountId" <> "intoAccountId");
ALTER TABLE "shareholders" ADD CONSTRAINT "shareholders_share_chk" CHECK ("shareBps" > 0 AND "shareBps" <= 10000);

-- ─── Row-level security (the guarded wave-A/B pattern, as 20261124140000_period_reopen_requests).
DO $do$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'app_is_service_mode')
     AND EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'app_tenant_ids') THEN
    FOREACH t IN ARRAY ARRAY['account_merges', 'account_merge_lines', 'shareholders']
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
