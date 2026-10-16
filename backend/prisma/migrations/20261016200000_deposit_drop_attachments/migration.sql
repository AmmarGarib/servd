-- Deposit slips as files (owner, 2026-10-16: "it should ask for attachment
-- instead of URL for supporting docs"). A deposit drop's bank slip / teller
-- receipt is stored in the existing evidence store (cash_voucher_attachments,
-- kind 'deposit_slip', stamped with the DROP's tenantId) — no new table.
-- RLS: cash_voucher_attachments already carries the tenantId policy
-- (20261014090000_finance_wave_b), which covers these rows unchanged.
ALTER TABLE "cash_voucher_attachments" ADD COLUMN "depositDropId" TEXT;

CREATE INDEX "cash_voucher_attachments_depositDropId_idx" ON "cash_voucher_attachments"("depositDropId");

ALTER TABLE "cash_voucher_attachments"
  ADD CONSTRAINT "cash_voucher_attachments_depositDropId_fkey"
  FOREIGN KEY ("depositDropId") REFERENCES "deposit_drops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The owner check grows a fourth owner: a deposit drop.
ALTER TABLE "cash_voucher_attachments" DROP CONSTRAINT IF EXISTS "cash_voucher_attachments_owner_chk";

-- ─── SQL-only objects (tests/setup.ts reads this section: no ';' inside a statement)
ALTER TABLE "cash_voucher_attachments" ADD CONSTRAINT "cash_voucher_attachments_owner_chk"
  CHECK ("voucherId" IS NOT NULL OR "boxId" IS NOT NULL OR "movementId" IS NOT NULL OR "depositDropId" IS NOT NULL);
