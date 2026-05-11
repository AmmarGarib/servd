-- Stamp for the post-complaint follow-up trigger so the lifecycle worker
-- doesn't re-send the "did we make it right?" message every tick.

ALTER TABLE "order_complaints"
  ADD COLUMN "followUpSentAt" TIMESTAMP(3);
