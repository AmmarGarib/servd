-- Recipe pricing spec — per spec PDF: Q factor, target profit, packaging,
-- actual selling price, recipe category, photo. Plus 'component' as a third
-- RecipeKind for sub-recipes, allergens + category + yield% on the ingredient
-- record, and forecast portions on the brand for the opex/portion calc.

-- ── RecipeKind: add 'component' value. Must run outside the migration's
--    implicit transaction because Postgres enum changes don't commit inside
--    DDL transactions until the surrounding statement ends.
ALTER TYPE "RecipeKind" ADD VALUE IF NOT EXISTS 'component';

-- ── Recipe pricing fields ────────────────────────────────────────────────
ALTER TABLE "recipes"
  ADD COLUMN IF NOT EXISTS "qFactorPct"              DOUBLE PRECISION NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS "targetProfitPct"         DOUBLE PRECISION NOT NULL DEFAULT 25,
  ADD COLUMN IF NOT EXISTS "packagingPct"            DOUBLE PRECISION NOT NULL DEFAULT 8,
  ADD COLUMN IF NOT EXISTS "actualSellingPriceCents" INTEGER,
  ADD COLUMN IF NOT EXISTS "category"                TEXT,
  ADD COLUMN IF NOT EXISTS "photoUrl"                TEXT;

-- ── Inventory: yield, allergens, category for ingredient-picker UX ──────
ALTER TABLE "inventory_items"
  ADD COLUMN IF NOT EXISTS "yieldPct"  DOUBLE PRECISION NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS "allergens" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS "category"  TEXT;

-- ── Concept: monthly forecast portions for Opex/Portion calc ────────────
ALTER TABLE "concepts"
  ADD COLUMN IF NOT EXISTS "forecastPortionsPerMonth" INTEGER NOT NULL DEFAULT 0;
