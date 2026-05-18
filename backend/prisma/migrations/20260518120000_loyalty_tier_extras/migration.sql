-- TierConfig grows the fields needed for a full operator-managed
-- loyalty / membership system: display name, ordering, paid/free flag,
-- monthly price, auto-upgrade spend threshold, active toggle, and a
-- freeform custom-perks string array for unstructured benefits.

ALTER TABLE "tier_configs"
  ADD COLUMN "displayName"       TEXT,
  ADD COLUMN "rank"               INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "isPaid"             BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "monthlyPriceCents"  INTEGER,
  ADD COLUMN "unlockSpendCents"   INTEGER,
  ADD COLUMN "isActive"           BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "customPerks"        TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
