-- Customer identity + booking invites (owner, 2026-10-26):
--   * customers.nickname — "the servd name", unique servd-wide, case-insensitive (index on lower()).
--   * customers.memberCode — internal member barcode 'SV' + 10 digits, set by a DB default on every insert
--     path; existing customers are backfilled once below (in creation order of the UPDATE scan).
--     The digits are a sequence value times an odd multiplier not divisible by 5, mod 10^10 — a bijection,
--     so codes never repeat yet are not consecutive.
--   * reservations.inviteTokenHash / inviteTokenCreatedAt — the booker's invite link (hashed).
--   * reservation_guests — members who joined a booking by link (tenantId = the brand's company, RLS).

ALTER TABLE "customers" ADD COLUMN "nickname" TEXT;
ALTER TABLE "customers" ADD COLUMN "memberCode" TEXT;
CREATE UNIQUE INDEX "customers_memberCode_key" ON "customers"("memberCode");

-- ─── SQL-only objects (tests/setup.ts runs this section; every statement idempotent, one per ';', no ';' inside)
CREATE SEQUENCE IF NOT EXISTS "customer_member_code_seq" START WITH 1;
CREATE OR REPLACE FUNCTION customer_member_code() RETURNS text LANGUAGE sql VOLATILE AS $fn$ SELECT 'SV' || lpad(((nextval('customer_member_code_seq') * 7380298837) % 10000000000)::text, 10, '0') $fn$;
ALTER TABLE "customers" ALTER COLUMN "memberCode" SET DEFAULT customer_member_code();
CREATE UNIQUE INDEX IF NOT EXISTS "customers_nickname_lower_key" ON "customers"(lower("nickname"));
-- ─── end SQL-only objects

UPDATE "customers" SET "memberCode" = customer_member_code() WHERE "memberCode" IS NULL;
ALTER TABLE "customers" ALTER COLUMN "memberCode" SET NOT NULL;

ALTER TABLE "reservations" ADD COLUMN "inviteTokenHash" TEXT;
ALTER TABLE "reservations" ADD COLUMN "inviteTokenCreatedAt" TIMESTAMP(3);
CREATE UNIQUE INDEX "reservations_inviteTokenHash_key" ON "reservations"("inviteTokenHash");

CREATE TABLE "reservation_guests" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "reservation_guests_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "reservation_guests_reservationId_customerId_key" ON "reservation_guests"("reservationId", "customerId");
CREATE INDEX "reservation_guests_tenantId_idx" ON "reservation_guests"("tenantId");
CREATE INDEX "reservation_guests_customerId_idx" ON "reservation_guests"("customerId");
ALTER TABLE "reservation_guests" ADD CONSTRAINT "reservation_guests_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "reservations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "reservation_guests" ADD CONSTRAINT "reservation_guests_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Row-level security (the guarded pattern, as 20261026180000_social_connections).
DO $do$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'app_is_service_mode')
     AND EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'app_tenant_ids') THEN
    FOREACH t IN ARRAY ARRAY['reservation_guests']
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
