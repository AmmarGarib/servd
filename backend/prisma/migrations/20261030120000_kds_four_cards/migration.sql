-- Owner, 2026-10-30: "make standard 4 cards on screen for all kitchen stations".
ALTER TABLE "stations" ALTER COLUMN "visibleCards" SET DEFAULT 4;
UPDATE "stations" SET "visibleCards" = 4 WHERE "visibleCards" <> 4;
