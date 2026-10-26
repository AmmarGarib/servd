-- Owner C1 (2026-10-26): managers and the CEO need at least 6 digits; a short
-- override PIN keeps working until its next use, then must be changed.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "pinChangeRequiredAt" TIMESTAMP(3);
