-- Create the reservation_policies table.
--
-- This table was only ever ALTERed (the very next migration,
-- 20260508020000_reservation_policy_time_params, adds the slot params) but no
-- migration ever created it — it must have been added out-of-band on the
-- environments where it exists. That broke replay onto a fresh database. This
-- migration creates it (minus the three slot columns the next migration adds).
--
-- CREATE ... IF NOT EXISTS keeps this a safe no-op on any environment that
-- already has the table, so it can be applied forward without conflicting with
-- the out-of-band table.

CREATE TABLE IF NOT EXISTS "reservation_policies" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'global',
    "scopeId" TEXT,
    "depositRequiredAboveParty" INTEGER,
    "depositCents" INTEGER NOT NULL DEFAULT 0,
    "noShowGraceMinutes" INTEGER NOT NULL DEFAULT 15,
    "cancellationWindowHours" INTEGER NOT NULL DEFAULT 24,
    "maxAdvanceDays" INTEGER NOT NULL DEFAULT 60,
    "minAdvanceHours" INTEGER NOT NULL DEFAULT 2,
    "maxPartySize" INTEGER NOT NULL DEFAULT 20,
    "walkInsAllowed" BOOLEAN NOT NULL DEFAULT true,
    "remindersEnabled" BOOLEAN NOT NULL DEFAULT true,
    "reminderHoursBefore" INTEGER NOT NULL DEFAULT 24,
    "notes" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "reservation_policies_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "reservation_policies_scope_scopeId_key" ON "reservation_policies"("scope", "scopeId");
