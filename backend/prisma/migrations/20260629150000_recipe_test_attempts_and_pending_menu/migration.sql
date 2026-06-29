-- Two changes:
--   1. Defer menu-item creation for testing plates. A plate created while in
--      `iteration` no longer gets a MenuItem immediately; the intended item is
--      stashed in recipes.pendingMenuItem and created only on approval.
--   2. Versioned recipe test attempts — a dated log of test cooks per recipe.

-- 1) Deferred new-menu-item payload (JSON: conceptId, categoryId, name, description).
ALTER TABLE "recipes" ADD COLUMN "pendingMenuItem" JSONB;

-- 2) Test attempts.
CREATE TYPE "RecipeTestOutcome" AS ENUM ('promising', 'needs_work', 'rejected');

CREATE TABLE "recipe_test_attempts" (
    "id"           TEXT NOT NULL,
    "recipeId"     TEXT NOT NULL,
    "version"      INTEGER NOT NULL,
    "notes"        TEXT NOT NULL,
    "outcome"      "RecipeTestOutcome",
    "rating"       INTEGER,
    "testedById"   TEXT NOT NULL,
    "testedByName" TEXT,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "recipe_test_attempts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "recipe_test_attempts_recipeId_version_key" ON "recipe_test_attempts"("recipeId", "version");
CREATE INDEX "recipe_test_attempts_recipeId_idx" ON "recipe_test_attempts"("recipeId");

ALTER TABLE "recipe_test_attempts"
  ADD CONSTRAINT "recipe_test_attempts_recipeId_fkey"
  FOREIGN KEY ("recipeId") REFERENCES "recipes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
