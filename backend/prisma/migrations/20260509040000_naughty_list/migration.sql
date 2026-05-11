-- Customer naughty list: strikes + bans.
--
-- Every offense (no-show, COD unpaid, refused at door) writes a strike.
-- 3 active strikes auto-promotes to a CustomerBan that gates email/phone
-- against fresh signups, public reservations, and guest orders.

-- Denormalized counters on Customer for fast UI checks
ALTER TABLE "customers"
  ADD COLUMN "strikeCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "bannedAt"    TIMESTAMP(3);

-- Strike rows
CREATE TABLE "customer_strikes" (
  "id"             TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "customerId"     TEXT NOT NULL REFERENCES "customers"("id") ON DELETE CASCADE,
  "kind"           TEXT NOT NULL,
  "sourceType"     TEXT,
  "sourceId"       TEXT,
  "severity"       INTEGER NOT NULL DEFAULT 1,
  "reason"         TEXT,
  "expiresAt"      TIMESTAMP(3),
  "reversedAt"     TIMESTAMP(3),
  "reversedById"   TEXT,
  "reversalReason" TEXT,
  "recordedById"   TEXT,
  "recordedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "customer_strikes_customerId_recordedAt_idx" ON "customer_strikes" ("customerId", "recordedAt");
CREATE INDEX "customer_strikes_kind_recordedAt_idx"       ON "customer_strikes" ("kind",       "recordedAt");

-- Ban rows — fingerprint-based gate against fresh signups & guest orders
CREATE TABLE "customer_bans" (
  "id"                 TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "customerId"         TEXT REFERENCES "customers"("id") ON DELETE SET NULL,
  "email"              TEXT,
  "phone"              TEXT,
  "ipAddresses"        TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "deviceFingerprints" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "reason"             TEXT NOT NULL,
  "bannedById"         TEXT,
  "bannedAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "liftedAt"           TIMESTAMP(3),
  "liftedById"         TEXT,
  "liftReason"         TEXT,
  "expiresAt"          TIMESTAMP(3)
);
CREATE INDEX "customer_bans_email_idx"    ON "customer_bans" ("email");
CREATE INDEX "customer_bans_phone_idx"    ON "customer_bans" ("phone");
CREATE INDEX "customer_bans_bannedAt_idx" ON "customer_bans" ("bannedAt");
CREATE INDEX "customer_bans_liftedAt_idx" ON "customer_bans" ("liftedAt");
