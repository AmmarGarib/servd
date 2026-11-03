-- The old-mastersheet clean-up is done (owner, 2026-11-03: "delete the stuff in 'removed' and delete the function of
-- sheet clean up. it won't be needed again"). Delete every retired master for good, then drop 'retired' again.
-- Company stock items linked to them lose the link (FK ON DELETE SET NULL); they already sit in the Trash.
UPDATE "recipe_ingredients" SET "masterIngredientId" = NULL
 WHERE "masterIngredientId" IN (SELECT id FROM "ingredient_masters" WHERE "status" = 'retired');
UPDATE "ingredient_masters" SET "mergedIntoId" = NULL
 WHERE "mergedIntoId" IN (SELECT id FROM "ingredient_masters" WHERE "status" = 'retired');
DELETE FROM "ingredient_master_prices"
 WHERE "masterIngredientId" IN (SELECT id FROM "ingredient_masters" WHERE "status" = 'retired');
DELETE FROM "ingredient_masters" WHERE "status" = 'retired';
ALTER TABLE "ingredient_masters" DROP CONSTRAINT IF EXISTS "ingredient_masters_status_chk";
ALTER TABLE "ingredient_masters" ADD CONSTRAINT "ingredient_masters_status_chk" CHECK ("status" IN ('approved', 'needs_review'));
