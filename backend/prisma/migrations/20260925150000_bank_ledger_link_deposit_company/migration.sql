-- One bank registry: the chart-of-accounts code holds the balance, and a
-- BankAccount row is that code's bank details (IBAN, branch, title).
--
--   bank_accounts.accountCode         the ledger code the money sits in
--   bank_statement_imports.tenantId   whose ledger the statement reconciles
--   bank_statement_imports.bankAccountId  the bank it is a statement of
--   deposit_drops.tenantId            whose cash was deposited
--   petty_cash_movements.supplierPaymentId  a spend that paid a supplier bill
--
-- Additive only; nothing is dropped. Backfills:
--   • bank accounts → '1020' (Bank — Operating Account), which every company's
--     chart carries (lib/chartOfAccounts.ts).
--   • statement imports → the company of a journal line one of its statement
--     lines matched, else the importer's company, else the oldest active
--     company (the rule the earlier company-scope migrations used). The bank
--     account is linked only when exactly one of that company's accounts
--     carries the import's code.
--   • deposit drops → the shift's company, else the bank account's, else the
--     brand's, else the person who dropped it.

-- AlterTable
ALTER TABLE "bank_statement_imports" ADD COLUMN     "bankAccountId" TEXT,
ADD COLUMN     "tenantId" TEXT;

-- AlterTable
ALTER TABLE "bank_accounts" ADD COLUMN     "accountCode" TEXT;

-- AlterTable
ALTER TABLE "petty_cash_movements" ADD COLUMN     "supplierPaymentId" TEXT;

-- AlterTable
ALTER TABLE "deposit_drops" ADD COLUMN     "tenantId" TEXT;

-- CreateIndex
CREATE INDEX "bank_statement_imports_tenantId_statementDate_idx" ON "bank_statement_imports"("tenantId", "statementDate" DESC);

-- CreateIndex
CREATE INDEX "deposit_drops_tenantId_droppedAt_idx" ON "deposit_drops"("tenantId", "droppedAt");

-- AddForeignKey
ALTER TABLE "bank_statement_imports" ADD CONSTRAINT "bank_statement_imports_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposit_drops" ADD CONSTRAINT "deposit_drops_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── Backfills ────────────────────────────────────────────────────────────
DO $$
DECLARE
  primary_tenant TEXT;
BEGIN
  SELECT id INTO primary_tenant FROM "tenants"
   WHERE "isActive" = true AND "deletedAt" IS NULL
   ORDER BY "createdAt" ASC LIMIT 1;

  -- Bank accounts: the operating bank code.
  UPDATE "bank_accounts" SET "accountCode" = '1020' WHERE "accountCode" IS NULL;

  -- Statement imports: the company whose journal line a statement line matched.
  UPDATE "bank_statement_imports" i SET "tenantId" = m."tenantId"
    FROM (
      SELECT DISTINCT ON (l."importId") l."importId", je."tenantId"
        FROM "bank_statement_lines" l
        JOIN "journal_lines" jl ON jl.id = l."matchedJournalLineId"
        JOIN "journal_entries" je ON je.id = jl."journalEntryId"
       WHERE je."tenantId" IS NOT NULL
       ORDER BY l."importId", l."postedDate"
    ) m
   WHERE i.id = m."importId" AND i."tenantId" IS NULL;
  -- …else the importer's company.
  UPDATE "bank_statement_imports" i SET "tenantId" = u."tenantId"
    FROM "users" u
   WHERE i."importedById" = u.id AND i."tenantId" IS NULL AND u."tenantId" IS NOT NULL;
  -- …else the oldest active company.
  IF primary_tenant IS NOT NULL THEN
    UPDATE "bank_statement_imports" SET "tenantId" = primary_tenant WHERE "tenantId" IS NULL;
  END IF;
  -- Link the bank account when exactly one of the company's accounts has the code.
  UPDATE "bank_statement_imports" i SET "bankAccountId" = b.id
    FROM "bank_accounts" b
   WHERE i."bankAccountId" IS NULL
     AND b."tenantId" = i."tenantId" AND b."accountCode" = i."accountCode" AND b."deletedAt" IS NULL
     AND (SELECT count(*) FROM "bank_accounts" b2
           WHERE b2."tenantId" = i."tenantId" AND b2."accountCode" = i."accountCode" AND b2."deletedAt" IS NULL) = 1;

  -- Deposit drops: the shift's company …
  UPDATE "deposit_drops" d SET "tenantId" = s."tenantId"
    FROM "shifts" s
   WHERE d."shiftId" = s.id AND d."tenantId" IS NULL AND s."tenantId" IS NOT NULL;
  -- … else the bank account's …
  UPDATE "deposit_drops" d SET "tenantId" = b."tenantId"
    FROM "bank_accounts" b
   WHERE d."bankAccountId" = b.id AND d."tenantId" IS NULL AND b."tenantId" IS NOT NULL;
  -- … else the brand's …
  UPDATE "deposit_drops" d SET "tenantId" = c."tenantId"
    FROM "concepts" c
   WHERE d."conceptId" = c.id AND d."tenantId" IS NULL AND c."tenantId" IS NOT NULL;
  -- … else the person who dropped it.
  UPDATE "deposit_drops" d SET "tenantId" = u."tenantId"
    FROM "users" u
   WHERE d."droppedById" = u.id AND d."tenantId" IS NULL AND u."tenantId" IS NOT NULL;
END $$;
