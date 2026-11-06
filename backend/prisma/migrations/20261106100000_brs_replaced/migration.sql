-- Bank reconciliations: several per period; the newest APPROVED one is the record (owner, 2026-11-06: "Make option to
-- make multiple recons, but record completed only (Approved by CEO), new Completed Bank recon should replace old one but
-- keep the record"). An approved one an overlapping newer approval replaces becomes 'superseded' — kept, with its
-- frozen approved statement, and a link to the one that replaced it.
ALTER TABLE "bank_reconciliations" ADD COLUMN "supersededById" TEXT, ADD COLUMN "supersededAt" TIMESTAMP(3);
ALTER TABLE "bank_reconciliations" DROP CONSTRAINT "bank_reconciliations_status_chk";

-- ─── SQL-only objects
ALTER TABLE "bank_reconciliations" ADD CONSTRAINT "bank_reconciliations_status_chk"
  CHECK ("status" IN ('draft', 'submitted', 'approved', 'superseded', 'cancelled') AND (("status" = 'superseded') = ("supersededById" IS NOT NULL)));
