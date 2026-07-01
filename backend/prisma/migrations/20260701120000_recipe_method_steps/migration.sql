-- Finished-plate method as an ordered, station-tagged step list. Sub-recipes
-- keep using the free-text `steps` (MOP); plates use this JSON array of
-- { station, instruction } objects. Nullable + additive — no backfill needed.
ALTER TABLE "recipes" ADD COLUMN IF NOT EXISTS "methodSteps" JSONB;
