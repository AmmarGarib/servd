-- v4: Mid-shift cash movements + Expo push token registry.

-- ─── CashMovement ───────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "CashMovementType" AS ENUM ('drop', 'add', 'payout', 'payin');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "cash_movements" (
  "id"                  TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "shiftId"             TEXT NOT NULL REFERENCES "shifts"("id"),
  "type"                "CashMovementType" NOT NULL,
  "amountCents"         INTEGER NOT NULL,
  "reason"              TEXT NOT NULL,
  "recordedById"        TEXT NOT NULL REFERENCES "users"("id"),
  "managerOverridePin"  TEXT,
  "recordedAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "cash_movements_shiftId_recordedAt_idx"
  ON "cash_movements" ("shiftId", "recordedAt");

-- ─── ExpoPushToken ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "expo_push_tokens" (
  "id"          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "userId"      TEXT NOT NULL REFERENCES "users"("id"),
  "token"       TEXT NOT NULL,
  "platform"    TEXT NOT NULL,
  "device"      TEXT NOT NULL,
  "locationId"  TEXT REFERENCES "locations"("id"),
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt"   TIMESTAMP(3)
);

-- (userId, token) unique = same device can re-register without bloating the table
CREATE UNIQUE INDEX IF NOT EXISTS "expo_push_tokens_userId_token_key"
  ON "expo_push_tokens" ("userId", "token");

CREATE INDEX IF NOT EXISTS "expo_push_tokens_userId_idx"        ON "expo_push_tokens" ("userId");
CREATE INDEX IF NOT EXISTS "expo_push_tokens_device_locationId_idx" ON "expo_push_tokens" ("device", "locationId");
