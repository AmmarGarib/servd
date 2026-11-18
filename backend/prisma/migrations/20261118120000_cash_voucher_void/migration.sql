-- 20261118120000_cash_voucher_void — void a PAID cash voucher with the CEO's
-- approval (owner, 2026-11-18: "how to void booked cash voucher?" → "finance
-- requests it with a reason and you approve it").
--
-- New status 'voided'; the voucher keeps who / when / why and the entry that
-- undid its expense. One request row per ask (tenantId = the voucher's
-- company, voucherId a plain id); one pending per voucher. Nothing is dropped.
--
-- Runbook: if this migration fails on deploy, run
--   prisma migrate resolve --rolled-back 20261118120000_cash_voucher_void
-- in the api image before redeploying any image (P3009 blocks every image).
SET lock_timeout = '10s';

ALTER TYPE "CashVoucherStatus" ADD VALUE IF NOT EXISTS 'voided';

ALTER TABLE "cash_vouchers" ADD COLUMN "voidedAt" TIMESTAMP(3);
ALTER TABLE "cash_vouchers" ADD COLUMN "voidedById" TEXT;
ALTER TABLE "cash_vouchers" ADD COLUMN "voidReason" TEXT;
ALTER TABLE "cash_vouchers" ADD COLUMN "voidEntryId" TEXT;

CREATE TABLE "cash_voucher_void_requests" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "voucherId" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "requestedById" TEXT NOT NULL,
  "decidedById" TEXT,
  "decidedAt" TIMESTAMP(3),
  "decisionNote" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "cash_voucher_void_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "cash_voucher_void_requests_tenantId_status_idx" ON "cash_voucher_void_requests"("tenantId", "status");
CREATE INDEX "cash_voucher_void_requests_voucherId_idx" ON "cash_voucher_void_requests"("voucherId");

-- ─── SQL-only objects (one statement per ';', no trailing comments)
CREATE UNIQUE INDEX "cash_voucher_void_requests_one_pending" ON "cash_voucher_void_requests"("voucherId") WHERE "status" = 'pending';
ALTER TABLE "cash_voucher_void_requests" ADD CONSTRAINT "cash_voucher_void_requests_status_chk" CHECK ("status" IN ('pending', 'approved', 'rejected', 'withdrawn'));
ALTER TABLE "cash_voucher_void_requests" ADD CONSTRAINT "cash_voucher_void_requests_reason_chk" CHECK (char_length(btrim("reason")) >= 10);

-- ─── Row-level security (the guarded wave-A/B pattern, as 20261105190000_employee_delete_requests).
DO $do$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'app_is_service_mode')
     AND EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'app_tenant_ids') THEN
    FOREACH t IN ARRAY ARRAY['cash_voucher_void_requests']
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
