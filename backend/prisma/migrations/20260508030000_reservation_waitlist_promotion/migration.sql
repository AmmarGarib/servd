-- Waitlist auto-promotion. When a reservation cancels or no-shows, a worker
-- offers the freed slot to a matching waitlist row by stamping a promotion
-- token + 30-min TTL onto that row + sending SMS+email. The guest claims
-- via /reserve/claim/<token>; the system atomically copies promoted-* fields
-- into the live booking fields.

ALTER TABLE "reservations"
  ADD COLUMN "promotionToken"            TEXT,
  ADD COLUMN "promotionExpiresAt"        TIMESTAMP(3),
  ADD COLUMN "promotionOfferedStartTime" TIMESTAMP(3),
  ADD COLUMN "promotionOfferedEndTime"   TIMESTAMP(3),
  ADD COLUMN "promotionOfferedTableId"   TEXT,
  ADD COLUMN "promotedFromWaitlistAt"    TIMESTAMP(3);

CREATE UNIQUE INDEX "reservations_promotionToken_key"
  ON "reservations" ("promotionToken");

CREATE INDEX "reservations_promotionExpiresAt_idx"
  ON "reservations" ("promotionExpiresAt");
