-- Merge the 'prep' recipe kind into 'component'.
--
-- Product decision: a "prep" (batch sub-recipe made ahead and consumed by the
-- gram inside plates) is the same thing as a "component". Rather than keep two
-- near-identical kinds, prep is folded into component. Both already cost as
-- cost-per-gram and link to plates via recipe_ingredients.prep_recipe.
--
-- Any existing prep recipes are remapped to component first so the enum drop
-- doesn't error on in-use values. Cost behaviour is unchanged — component
-- recipes already cost per gram and never carry an opex/portion allocation.

-- Re-map historical prep recipes so the enum drop doesn't error on existing data.
UPDATE "recipes" SET "kind" = 'component'::"RecipeKind" WHERE "kind" = 'prep';

-- Postgres can't DROP VALUE on an enum in use — rename the old type, create a
-- fresh one without 'prep', swap the column type, drop the old. The column
-- default references the enum, so drop it before the swap and restore after.
ALTER TABLE "recipes" ALTER COLUMN "kind" DROP DEFAULT;
ALTER TYPE "RecipeKind" RENAME TO "RecipeKind_old";
CREATE TYPE "RecipeKind" AS ENUM ('plate', 'component');
ALTER TABLE "recipes"
  ALTER COLUMN "kind" TYPE "RecipeKind"
  USING ("kind"::text::"RecipeKind");
ALTER TABLE "recipes" ALTER COLUMN "kind" SET DEFAULT 'plate';
DROP TYPE "RecipeKind_old";
