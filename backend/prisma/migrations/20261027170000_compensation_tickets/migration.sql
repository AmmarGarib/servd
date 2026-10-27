-- Compensation tickets (owner, 2026-10-27: "extend Complaints"). Every customer
-- compensation at the till — a void (line or whole bill), a comp / No Charge,
-- a refund (credit-note pay-outs and card-machine refunds included), a
-- discount above the limit and a price override — becomes ONE OrderComplaint
-- of kind 'compensation', made from its audit row / review flag by
-- src/modules/complaints/compensation.ts (compSourceRef unique = made once).
-- Managers' tickets go through; the CEO may flag one. No new table: the
-- order_complaints RLS policy (by the brand's company) already covers it.

ALTER TABLE "order_complaints"
  ADD COLUMN "compType" TEXT,
  ADD COLUMN "compValueCents" INTEGER,
  ADD COLUMN "compApproverId" TEXT,
  ADD COLUMN "compActorId" TEXT,
  ADD COLUMN "compSourceRef" TEXT,
  ADD COLUMN "compFlaggedAt" TIMESTAMP(3),
  ADD COLUMN "compFlaggedById" TEXT,
  ADD COLUMN "compFlagNote" TEXT,
  ADD COLUMN "compFlagExceptionId" TEXT;

CREATE UNIQUE INDEX "order_complaints_compSourceRef_key" ON "order_complaints"("compSourceRef");
CREATE INDEX "order_complaints_kind_compType_createdAt_idx" ON "order_complaints"("kind", "compType", "createdAt");

ALTER TABLE "order_complaints" DROP CONSTRAINT IF EXISTS "order_complaints_kind_chk";

-- ─── SQL-only objects (read by tests/setup.ts: no ';' inside a statement, no trailing comments)
ALTER TABLE "order_complaints" ADD CONSTRAINT "order_complaints_kind_chk" CHECK ("kind" IN ('complaint', 'ban_appeal', 'compensation'));
ALTER TABLE "order_complaints" ADD CONSTRAINT "order_complaints_compensation_chk" CHECK (("kind" = 'compensation') = ("compType" IS NOT NULL AND "compSourceRef" IS NOT NULL AND "compValueCents" IS NOT NULL));
ALTER TABLE "order_complaints" ADD CONSTRAINT "order_complaints_comp_type_chk" CHECK ("compType" IS NULL OR "compType" IN ('void', 'comp', 'refund', 'discount', 'price_override'));
ALTER TABLE "order_complaints" ADD CONSTRAINT "order_complaints_comp_flag_chk" CHECK ("compFlaggedAt" IS NULL OR ("compFlaggedById" IS NOT NULL AND "compFlagNote" IS NOT NULL));
