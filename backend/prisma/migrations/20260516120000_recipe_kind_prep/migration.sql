-- Recipe kinds: plate (current behaviour, costed as plate cost) vs prep
-- (sub-recipe, costed as cost-per-gram so it can be consumed inside a plate).
--
-- Strategy:
--   - All existing recipes are kind='plate' (default). Behaviour unchanged.
--   - menuItemId becomes nullable so prep recipes can exist without a MenuItem.
--   - RecipeIngredient.inventoryItemId becomes nullable; new prepRecipeId
--     column points at another Recipe row. Exactly one of the two is set,
--     enforced by a CHECK constraint.

CREATE TYPE "RecipeKind" AS ENUM ('plate', 'prep');

ALTER TABLE "Recipe"
  ADD COLUMN "kind"        "RecipeKind" NOT NULL DEFAULT 'plate',
  ADD COLUMN "name"        TEXT,
  ADD COLUMN "yieldGrams"  DOUBLE PRECISION;

-- menuItemId must allow NULL now that prep recipes have no MenuItem.
ALTER TABLE "Recipe"
  ALTER COLUMN "menuItemId" DROP NOT NULL;

-- The existing @unique on menuItemId becomes a partial unique index so
-- multiple prep recipes with NULL menuItemId can coexist. Postgres treats
-- NULLs as distinct in standard unique indexes, but being explicit avoids
-- surprises across DB engines and clarifies intent.
DROP INDEX IF EXISTS "Recipe_menuItemId_key";
CREATE UNIQUE INDEX "Recipe_menuItemId_key" ON "Recipe"("menuItemId")
  WHERE "menuItemId" IS NOT NULL;

-- RecipeIngredient: allow either an inventory item OR a prep recipe.
ALTER TABLE "recipe_ingredients"
  ALTER COLUMN "inventoryItemId" DROP NOT NULL,
  ADD COLUMN  "prepRecipeId" TEXT;

ALTER TABLE "recipe_ingredients"
  ADD CONSTRAINT "recipe_ingredients_prepRecipeId_fkey"
    FOREIGN KEY ("prepRecipeId") REFERENCES "Recipe"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Mutual exclusion: exactly one of inventoryItemId / prepRecipeId is set.
ALTER TABLE "recipe_ingredients"
  ADD CONSTRAINT "recipe_ingredients_one_source"
    CHECK (
      ("inventoryItemId" IS NOT NULL AND "prepRecipeId" IS NULL)
      OR
      ("inventoryItemId" IS NULL AND "prepRecipeId" IS NOT NULL)
    );

CREATE INDEX "recipe_ingredients_prepRecipeId_idx" ON "recipe_ingredients"("prepRecipeId");
