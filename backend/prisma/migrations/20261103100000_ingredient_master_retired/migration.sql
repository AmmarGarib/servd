-- Ingredients sheet clean-up (owner, 2026-11-03): a master removed from the sheet is 'retired' (hidden, restorable;
-- modules/ingredientMaster/cleanup.ts). Widen the status check to allow it.
ALTER TABLE "ingredient_masters" DROP CONSTRAINT IF EXISTS "ingredient_masters_status_chk";
ALTER TABLE "ingredient_masters" ADD CONSTRAINT "ingredient_masters_status_chk" CHECK ("status" IN ('approved', 'needs_review', 'retired'));
