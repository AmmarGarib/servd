-- Cash vouchers paid from cash on hand or a bank account (owner, 2026-10-16:
-- "Give the option box to pay from petty cash/Cash on hand and bank accounts").
-- Every existing row was paid (or will be paid) from a petty-cash box: 'box'.
ALTER TABLE "cash_vouchers"
  ADD COLUMN "paySource" TEXT NOT NULL DEFAULT 'box',
  ADD COLUMN "payAccountCode" TEXT,
  ADD COLUMN "payBankAccountId" TEXT,
  ADD COLUMN "payJournalEntryId" TEXT;

CREATE UNIQUE INDEX "cash_vouchers_payJournalEntryId_key" ON "cash_vouchers"("payJournalEntryId");

-- ─── SQL-only objects (tests/setup.ts reads this section: no ';' inside a statement)
-- A cash-on-hand / bank pay names the account it came out of; a box pay never does.
ALTER TABLE "cash_vouchers" ADD CONSTRAINT "cash_vouchers_pay_source_chk" CHECK (
  "paySource" IN ('box', 'cash_on_hand', 'bank')
  AND ("paySource" = 'box' OR "payAccountCode" IS NOT NULL OR "disbursedAt" IS NULL)
);
