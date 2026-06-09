-- Campaign engagement tracking: click + open counters on each send so we can
-- compute email/push CTR and open rate. Populated by the public tracking
-- endpoints (/t/c/:id redirect, /t/o/:id pixel). Additive + idempotent.

ALTER TABLE "campaign_sends"
  ADD COLUMN IF NOT EXISTS "clickCount"     INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "openCount"      INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "firstClickedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "firstOpenedAt"  TIMESTAMP(3);
