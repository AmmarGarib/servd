-- Journals between companies (owner, 2026-11-12: "When i pass journal in GS which is related to Flipd, it should also
-- appear in FLIPD to book same entry as receiving voucher with same details (editable)"; "It should hit FLIPD's
-- payable account and same procedure if an entry is passed through FLIPD"; "It should not require CEO's approval, CEO
-- should get a notification instead"). accounting/mirrorDrafts.ts.
SET lock_timeout = '10s';

-- An account linked to another company: a manual journal on it raises a draft in that company, on its account
-- `relatedAccountCode` (e.g. GS "2031 Loan to FLIPD" → Flipd "Payable to GS Foods").
ALTER TABLE "accounts" ADD COLUMN "relatedTenantId" TEXT;
ALTER TABLE "accounts" ADD COLUMN "relatedAccountCode" TEXT;
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_relatedTenantId_fkey" FOREIGN KEY ("relatedTenantId") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_related_pair_chk" CHECK (("relatedTenantId" IS NULL) = ("relatedAccountCode" IS NULL));

CREATE TABLE "intercompany_journal_drafts" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "sourceTenantId" TEXT NOT NULL,
  "sourceEntryId" TEXT NOT NULL,
  "sourceVoucherNo" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "voucherKind" TEXT NOT NULL,
  "entryDate" TIMESTAMP(3) NOT NULL,
  "description" TEXT NOT NULL,
  "lines" JSONB NOT NULL,
  "postedEntryId" TEXT,
  "decidedById" TEXT,
  "decidedAt" TIMESTAMP(3),
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "intercompany_journal_drafts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "intercompany_journal_drafts_status_chk" CHECK ("status" IN ('pending', 'posted', 'dismissed', 'withdrawn'))
);
CREATE UNIQUE INDEX "intercompany_journal_drafts_sourceEntryId_tenantId_key" ON "intercompany_journal_drafts"("sourceEntryId", "tenantId");
CREATE UNIQUE INDEX "intercompany_journal_drafts_postedEntryId_key" ON "intercompany_journal_drafts"("postedEntryId");
CREATE INDEX "intercompany_journal_drafts_tenantId_status_idx" ON "intercompany_journal_drafts"("tenantId", "status");
CREATE INDEX "intercompany_journal_drafts_sourceTenantId_idx" ON "intercompany_journal_drafts"("sourceTenantId");

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'app_is_service_mode')
     AND EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'app_tenant_ids')
     AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename = 'intercompany_journal_drafts') THEN
    ALTER TABLE "intercompany_journal_drafts" ENABLE ROW LEVEL SECURITY;
    CREATE POLICY "intercompany_journal_drafts_rls" ON "intercompany_journal_drafts" FOR ALL
      USING (app_is_service_mode() OR "intercompany_journal_drafts"."tenantId" = ANY(app_tenant_ids()) OR "intercompany_journal_drafts"."sourceTenantId" = ANY(app_tenant_ids()))
      WITH CHECK (app_is_service_mode() OR "intercompany_journal_drafts"."tenantId" = ANY(app_tenant_ids()) OR "intercompany_journal_drafts"."sourceTenantId" = ANY(app_tenant_ids()));
  END IF;
END
$do$;
