-- Recipe view (owner, 2026-11-12: "make them in flipd. But add all flipd recipes to gs foods because I own a stake in
-- flipd and I am gs foods"). A brand's company owns and writes its recipes; another company may READ them.
ALTER TABLE "concepts" ADD COLUMN "recipeViewerTenantId" TEXT;
CREATE INDEX "concepts_recipeViewerTenantId_idx" ON "concepts"("recipeViewerTenantId");

-- Every brand whose recipes another company OWNED (Flipd → GS Foods) now owns them itself; the old owner keeps a
-- read-only view. Its dish and add-on recipes move to the brand's company, and so does every sub-recipe the old owner
-- held that ONLY this brand's dishes / add-ons use (directly or nested). A sub-recipe another brand also uses stays.
CREATE TEMP TABLE _flip AS
  SELECT id AS concept_id, "tenantId" AS brand_tenant, "recipeOwnerTenantId" AS old_owner
    FROM concepts
   WHERE "recipeOwnerTenantId" IS NOT NULL AND "tenantId" IS NOT NULL AND "recipeOwnerTenantId" <> "tenantId";

-- The brand of every dish / add-on recipe (live or pending).
CREATE TEMP TABLE _root AS
  SELECT r.id, COALESCE(mi."conceptId", mg_mi."conceptId", r."pendingMenuItem"->>'conceptId') AS concept_id
    FROM recipes r
    LEFT JOIN menu_items mi ON mi.id = r."menuItemId"
    LEFT JOIN modifiers m ON m.id = r."modifierId"
    LEFT JOIN modifier_groups mg ON mg.id = m."groupId"
    LEFT JOIN menu_items mg_mi ON mg_mi.id = mg."menuItemId"
   WHERE r.kind IN ('plate', 'modifier');

-- Sub-recipes reachable from each root.
CREATE TEMP TABLE _reach AS
  WITH RECURSIVE walk(root_id, recipe_id) AS (
    SELECT ri."recipeId", ri."prepRecipeId" FROM recipe_ingredients ri
      JOIN _root ON _root.id = ri."recipeId" WHERE ri."prepRecipeId" IS NOT NULL
    UNION
    SELECT w.root_id, ri."prepRecipeId" FROM recipe_ingredients ri
      JOIN walk w ON ri."recipeId" = w.recipe_id WHERE ri."prepRecipeId" IS NOT NULL
  )
  SELECT DISTINCT w.recipe_id, _root.concept_id FROM walk w JOIN _root ON _root.id = w.root_id;

UPDATE recipes r SET "tenantId" = f.brand_tenant
  FROM _flip f
 WHERE r.kind = 'component' AND r."tenantId" = f.old_owner
   AND EXISTS (SELECT 1 FROM _reach x WHERE x.recipe_id = r.id AND x.concept_id = f.concept_id)
   AND NOT EXISTS (SELECT 1 FROM _reach x WHERE x.recipe_id = r.id AND (x.concept_id IS NULL OR x.concept_id <> f.concept_id));

UPDATE recipes r SET "tenantId" = f.brand_tenant
  FROM _root, _flip f
 WHERE r.id = _root.id AND _root.concept_id = f.concept_id;

UPDATE concepts c SET "recipeViewerTenantId" = f.old_owner, "recipeOwnerTenantId" = NULL
  FROM _flip f WHERE c.id = f.concept_id;

DROP TABLE _reach;
DROP TABLE _root;
DROP TABLE _flip;
