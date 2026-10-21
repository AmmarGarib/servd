-- 20261021100000_shift_corrections — Shift corrections (owner, 2026-10-21):
-- "A shift closed by staff/cashier, Finance should have access to reopen the
-- shift and cancel any KOT, with CEO's approval … all this void & cancellation
-- should require CEO's approval to move the entry to trash."
--
-- Finance raises ONE set of fixes on a closed drawer (void a full & final bill,
-- cancel an open KOT); the CEO approves or rejects the set once; nothing moves
-- until it is approved (modules/shiftCorrections/). tenantId = the SHIFT's
-- company. One open (submitted) set per shift.
--
-- Runbook: if this migration fails on deploy, run
--   prisma migrate resolve --rolled-back 20261021100000_shift_corrections
-- in the api image before redeploying any image (P3009 blocks every image).
-- Rollback: an older image ignores the tables; an applied set's ledger entries
-- ('shift.close.reversal:<shiftId>', 'shift.close:<shiftId>@n') stay valid
-- double entries, but an older image's readers look up 'shift.close:<id>'
-- exactly and see the reversed original — do not roll back below this release
-- once a set has been applied.
SET lock_timeout = '10s';

CREATE TYPE "ShiftCorrectionStatus" AS ENUM ('submitted', 'approved', 'rejected', 'applied', 'failed');
CREATE TYPE "ShiftCorrectionKind" AS ENUM ('void_bill', 'cancel_kot', 'void_reissue');

CREATE TABLE "shift_corrections" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "shiftId" TEXT NOT NULL,
  "businessDay" TEXT NOT NULL,
  "status" "ShiftCorrectionStatus" NOT NULL DEFAULT 'submitted',
  "reason" TEXT NOT NULL,
  "requestedById" TEXT NOT NULL,
  "decidedById" TEXT,
  "decidedAt" TIMESTAMP(3),
  "decisionNote" TEXT,
  "appliedAt" TIMESTAMP(3),
  "error" TEXT,
  "result" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "shift_corrections_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "shift_correction_items" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "correctionId" TEXT NOT NULL,
  "kind" "ShiftCorrectionKind" NOT NULL,
  "orderId" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "moneyReturned" BOOLEAN NOT NULL DEFAULT false,
  "foodMade" BOOLEAN NOT NULL DEFAULT false,
  "newTender" TEXT,
  "result" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "shift_correction_items_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "shift_corrections_tenantId_status_idx" ON "shift_corrections"("tenantId", "status");
CREATE INDEX "shift_corrections_shiftId_idx" ON "shift_corrections"("shiftId");
CREATE UNIQUE INDEX "shift_correction_items_correctionId_orderId_key" ON "shift_correction_items"("correctionId", "orderId");
CREATE INDEX "shift_correction_items_tenantId_idx" ON "shift_correction_items"("tenantId");
CREATE INDEX "shift_correction_items_orderId_idx" ON "shift_correction_items"("orderId");

ALTER TABLE "shift_corrections" ADD CONSTRAINT "shift_corrections_shiftId_fkey"
  FOREIGN KEY ("shiftId") REFERENCES "shifts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shift_correction_items" ADD CONSTRAINT "shift_correction_items_correctionId_fkey"
  FOREIGN KEY ("correctionId") REFERENCES "shift_corrections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── SQL-only objects (one statement per ';', no trailing comments)
CREATE UNIQUE INDEX "shift_corrections_one_open" ON "shift_corrections"("shiftId") WHERE "status" = 'submitted';
ALTER TABLE "shift_corrections" ADD CONSTRAINT "shift_corrections_reason_chk" CHECK (char_length(btrim("reason")) >= 10);
ALTER TABLE "shift_correction_items" ADD CONSTRAINT "shift_correction_items_reason_chk" CHECK (char_length(btrim("reason")) >= 10);
ALTER TABLE "shift_correction_items" ADD CONSTRAINT "shift_correction_items_tender_chk" CHECK ("kind" <> 'void_reissue' OR "newTender" IS NOT NULL);

-- ─── Row-level security (the guarded wave-A/B pattern, as 20261020100000_payment_classification)
DO $do$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'app_is_service_mode')
     AND EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'app_tenant_ids') THEN
    FOREACH t IN ARRAY ARRAY['shift_corrections', 'shift_correction_items']
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
