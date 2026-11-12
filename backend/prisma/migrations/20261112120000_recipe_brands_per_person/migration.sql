-- The brands a person writes recipes for (owner, 2026-11-12: "Hanif's brand list show only G's Kitchen" — Yes).
-- Empty = every brand they can reach (unchanged). The CEO sets it on Workforce; recipes/routes.ts enforces it.
ALTER TABLE "users" ADD COLUMN "recipeConceptIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
