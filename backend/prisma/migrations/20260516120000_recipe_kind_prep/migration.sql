-- Recipe kinds: plate (current behaviour, costed as plate cost) vs prep
-- (sub-recipe, costed as cost-per-gram so it can be consumed inside a plate).
--
-- Strategy:
--   - All existing recipes are kind='plate' (default). Behaviour unchanged.
--   - menuItemId becomes nullable so prep recipes can exist without a MenuItem.
--   - RecipeIngredient.inventoryItemId becomes nullable; new prepRecipeId
--     column points at another Recipe row. Exactly one of the two is set,
--     enforced by a CHECK constraint.
--
-- Fix history: original draft used "Recipe" (PascalCase) which doesn't
-- match the @@map("recipes") table name. The CREATE TYPE went through
-- but the ALTER TABLEs failed silently and left the migration in a
-- never-finished state. Corrected to use the actual table name.

DO $$ BEGIN
  CREATE TYPE "RecipeKind" AS ENUM ('plate', 'prep');
EXCEPTION WHEN duplicate_object THEN null; END $$;

ALTER TABLE "recipes"
  ADD COLUMN IF NOT EXISTS "kind"        "RecipeKind" NOT NULL DEFAULT 'plate',
  ADD COLUMN IF NOT EXISTS "name"        TEXT,
  ADD COLUMN IF NOT EXISTS "yieldGrams"  DOUBLE PRECISION;

-- menuItemId must allow NULL now that prep recipes have no MenuItem.
ALTER TABLE "recipes"
  ALTER COLUMN "menuItemId" DROP NOT NULL;

-- The existing @unique on menuItemId becomes a partial unique index so
-- multiple prep recipes with NULL menuItemId can coexist.
DROP INDEX IF EXISTS "recipes_menuItemId_key";
CREATE UNIQUE INDEX "recipes_menuItemId_key" ON "recipes"("menuItemId")
  WHERE "menuItemId" IS NOT NULL;

-- RecipeIngredient: allow either an inventory item OR a prep recipe.
ALTER TABLE "recipe_ingredients"
  ALTER COLUMN "inventoryItemId" DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS "prepRecipeId" TEXT;

DO $$ BEGIN
  ALTER TABLE "recipe_ingredients"
    ADD CONSTRAINT "recipe_ingredients_prepRecipeId_fkey"
      FOREIGN KEY ("prepRecipeId") REFERENCES "recipes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Mutual exclusion: exactly one of inventoryItemId / prepRecipeId is set.
DO $$ BEGIN
  ALTER TABLE "recipe_ingredients"
    ADD CONSTRAINT "recipe_ingredients_one_source"
      CHECK (
        ("inventoryItemId" IS NOT NULL AND "prepRecipeId" IS NULL)
        OR
        ("inventoryItemId" IS NULL AND "prepRecipeId" IS NOT NULL)
      );
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE INDEX IF NOT EXISTS "recipe_ingredients_prepRecipeId_idx" ON "recipe_ingredients"("prepRecipeId");
