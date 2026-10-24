-- City Ledger (owner, 2026-10-24: "Extend on-account" — the on-account clients ARE the city ledger; one store).
-- Additive only: an account type on the client, per-bill settlement of a client's till bills (a settlement + its
-- explicit split across bills), and how much of each bill was settled that way.

ALTER TABLE "customer_accounts" ADD COLUMN "accountType" TEXT NOT NULL DEFAULT 'company';

ALTER TABLE "customer_account_charges" ADD COLUMN "settledCents" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "city_ledger_settlements" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "amountCents" BIGINT NOT NULL,
    "method" TEXT NOT NULL,
    "reference" TEXT,
    "bankAccountId" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "channel" TEXT NOT NULL,
    "shiftId" TEXT,
    "cashMovementId" TEXT,
    "reversalCashMovementId" TEXT,
    "moneyAccountCode" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "note" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversedAt" TIMESTAMP(3),
    "reversedById" TEXT,
    "reversedReason" TEXT,
    CONSTRAINT "city_ledger_settlements_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "city_ledger_settlements_tenantId_number_key" ON "city_ledger_settlements"("tenantId", "number");
CREATE UNIQUE INDEX "city_ledger_settlements_tenantId_idempotencyKey_key" ON "city_ledger_settlements"("tenantId", "idempotencyKey");
CREATE UNIQUE INDEX "city_ledger_settlements_cashMovementId_key" ON "city_ledger_settlements"("cashMovementId");
CREATE INDEX "city_ledger_settlements_tenantId_accountId_receivedAt_idx" ON "city_ledger_settlements"("tenantId", "accountId", "receivedAt");
CREATE UNIQUE INDEX "city_ledger_settlements_reversalCashMovementId_key" ON "city_ledger_settlements"("reversalCashMovementId");
CREATE INDEX "city_ledger_settlements_shiftId_idx" ON "city_ledger_settlements"("shiftId");
ALTER TABLE "city_ledger_settlements" ADD CONSTRAINT "city_ledger_settlements_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "customer_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "city_ledger_allocations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "settlementId" TEXT NOT NULL,
    "chargeId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    CONSTRAINT "city_ledger_allocations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "city_ledger_allocations_settlementId_chargeId_key" ON "city_ledger_allocations"("settlementId", "chargeId");
CREATE INDEX "city_ledger_allocations_chargeId_idx" ON "city_ledger_allocations"("chargeId");
CREATE INDEX "city_ledger_allocations_tenantId_idx" ON "city_ledger_allocations"("tenantId");
ALTER TABLE "city_ledger_allocations" ADD CONSTRAINT "city_ledger_allocations_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "city_ledger_settlements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "city_ledger_allocations" ADD CONSTRAINT "city_ledger_allocations_chargeId_fkey" FOREIGN KEY ("chargeId") REFERENCES "customer_account_charges"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Payment terms may be "immediate" (0 days): the old CHECK goes (re-made below).
ALTER TABLE "customer_accounts" DROP CONSTRAINT IF EXISTS "customer_accounts_chk";

-- ─── SQL-only objects (tests/setup.ts applies this section after dropping customer_accounts_chk itself)
ALTER TABLE "customer_accounts" ADD CONSTRAINT "customer_accounts_chk" CHECK ("creditLimitCents" >= 0 AND "termsDays" BETWEEN 0 AND 180 AND "overdueGraceDays" BETWEEN 0 AND 90);
ALTER TABLE "customer_accounts" ADD CONSTRAINT "customer_accounts_account_type_chk" CHECK ("accountType" IN ('company', 'corporate', 'travel_agent', 'guest', 'other'));
ALTER TABLE "customer_account_charges" ADD CONSTRAINT "customer_account_charges_settled_chk" CHECK ("settledCents" >= 0);
ALTER TABLE "city_ledger_settlements" ADD CONSTRAINT "city_ledger_settlements_amount_chk" CHECK ("amountCents" > 0);
ALTER TABLE "city_ledger_settlements" ADD CONSTRAINT "city_ledger_settlements_channel_chk" CHECK ("channel" IN ('till', 'back_office'));
ALTER TABLE "city_ledger_settlements" ADD CONSTRAINT "city_ledger_settlements_till_chk" CHECK (("channel" = 'till') = ("shiftId" IS NOT NULL));
ALTER TABLE "city_ledger_allocations" ADD CONSTRAINT "city_ledger_allocations_amount_chk" CHECK ("amountCents" > 0);

-- ─── Row-level security (the guarded wave-A/B pattern, as 20261022170000_menu_subcategories_sessions)
DO $do$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'app_is_service_mode')
     AND EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'app_tenant_ids') THEN
    FOREACH t IN ARRAY ARRAY['city_ledger_settlements', 'city_ledger_allocations']
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
