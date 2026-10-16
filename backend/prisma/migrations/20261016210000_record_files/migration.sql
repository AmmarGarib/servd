-- Record files (owner, 2026-10-16: "Yes" to switching every supporting-document
-- URL to an upload; "One private store … so any record can carry files — only
-- staff of that company can open them, View + Download. One store across
-- servd, no new copies"). The existing evidence store (cash_voucher_attachments,
-- bytes in the DB) gains a GENERIC owner: (ownerType, ownerId), kind
-- 'record_file', stamped with the OWNING record's tenantId. lib/recordFiles.ts
-- is the one writer / reader (a provider per ownerType).
-- RLS: cash_voucher_attachments already carries the tenantId policy
-- (20261014090000_finance_wave_b), which covers these rows unchanged.
ALTER TABLE "cash_voucher_attachments" ADD COLUMN "ownerType" TEXT;
ALTER TABLE "cash_voucher_attachments" ADD COLUMN "ownerId" TEXT;

CREATE INDEX "cash_voucher_attachments_tenantId_ownerType_ownerId_idx" ON "cash_voucher_attachments"("tenantId", "ownerType", "ownerId");

-- The owner check grows a fifth owner: any record, named by BOTH ownerType and ownerId.
ALTER TABLE "cash_voucher_attachments" DROP CONSTRAINT IF EXISTS "cash_voucher_attachments_owner_chk";

-- ─── SQL-only objects (tests/setup.ts reads this section: no ';' inside a statement)
ALTER TABLE "cash_voucher_attachments" ADD CONSTRAINT "cash_voucher_attachments_owner_chk"
  CHECK ("voucherId" IS NOT NULL OR "boxId" IS NOT NULL OR "movementId" IS NOT NULL OR "depositDropId" IS NOT NULL OR ("ownerType" IS NOT NULL AND "ownerId" IS NOT NULL));

ALTER TABLE "cash_voucher_attachments" ADD CONSTRAINT "cash_voucher_attachments_owner_pair_chk"
  CHECK (("ownerType" IS NULL) = ("ownerId" IS NULL));
