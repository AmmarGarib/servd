-- Per-user station assignment. Drives the new /kds kitchen dashboard so a
-- line cook only sees the stations they're rostered to. Empty array =
-- "not restricted" (admin / management / expediter).
ALTER TABLE "users"
  ADD COLUMN "stationIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
