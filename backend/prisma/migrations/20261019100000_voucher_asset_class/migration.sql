-- Equipment on a finance payee voucher (owner, 2026-10-19): a payee voucher (kind 'expense') may name a
-- fixed-asset class instead of an expense account. Finance's pay books it through the CapEx Quick-buy engine
-- (Dr 1340 / Cr the source, the capitalisation request for the CEO); the voucher remembers the class, the outlet
-- and the CapEx line / capitalisation request it became. Additive, nullable: a rollback to an older image ignores
-- the columns (an unpaid asset voucher has no expense account there, so an older image refuses to pay it).
ALTER TABLE "cash_vouchers"
  ADD COLUMN "assetClassId"      TEXT,
  ADD COLUMN "assetLocationId"   TEXT,
  ADD COLUMN "capexLineId"       TEXT,
  ADD COLUMN "capitaliseEventId" TEXT;

CREATE UNIQUE INDEX "cash_vouchers_capexLineId_key" ON "cash_vouchers"("capexLineId");
