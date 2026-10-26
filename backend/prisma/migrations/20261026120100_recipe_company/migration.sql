-- Kitchen flow, part B (owner, 2026-10-26, K4): "Recipes belong to a COMPANY, not a brand. GS Foods owns Stackd's and
-- Simmer's recipes. Flipd is its own company (Pvt Ltd); Flipd's recipes are OWNED BY GS FOODS and USED by Flipd. Stock
-- and sales stay separate PER OUTLET." Additive.
--
--   recipes."tenantId"                 the OWNER company (who creates, edits, approves, deletes). Backfill:
--                                      plate → its brand's company (pending plates: the pending brand's);
--                                      add-on (modifier) → its dish's brand's company;
--                                      sub-recipe → the ONE company whose dishes / add-ons use it; with none, the
--                                      ONE company whose stock it is made from; else its creator's company when that
--                                      company is among its users (or nothing uses it); else NULL — left for a
--                                      person (the API flags each one: recipe_company_unknown).
--   concepts."recipeOwnerTenantId"     the company that OWNS a brand's recipes when it is not the brand's own
--                                      (Flipd → GS Foods). The CEO sets it on the brand editor; NULL here.
--   inventory_items prep items          one per (company, recipe) — a shared sub-recipe is prepped as stock in each
--                                      company that cooks it (was one per recipe).

ALTER TABLE "recipes" ADD COLUMN "tenantId" TEXT,
ADD COLUMN "portionsPerBatch" INTEGER,
ADD COLUMN "portionLabel" TEXT;
CREATE INDEX "recipes_tenantId_idx" ON "recipes"("tenantId");
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "concepts" ADD COLUMN "recipeOwnerTenantId" TEXT;
CREATE INDEX "concepts_recipeOwnerTenantId_idx" ON "concepts"("recipeOwnerTenantId");

DROP INDEX IF EXISTS "inventory_items_prepRecipeId_key";
CREATE UNIQUE INDEX "inventory_items_tenantId_prepRecipeId_key" ON "inventory_items"("tenantId", "prepRecipeId");

-- Plates: their brand's company (a dish already on the menu, else the brand the pending dish is filed under).
UPDATE "recipes" r SET "tenantId" = c."tenantId"
  FROM "menu_items" m JOIN "concepts" c ON c.id = m."conceptId"
 WHERE r."kind" = 'plate' AND r."menuItemId" = m.id AND r."tenantId" IS NULL;
UPDATE "recipes" r SET "tenantId" = c."tenantId"
  FROM "concepts" c
 WHERE r."kind" = 'plate' AND r."tenantId" IS NULL AND r."menuItemId" IS NULL AND r."pendingMenuItem" IS NOT NULL
   AND c.id = (r."pendingMenuItem" ->> 'conceptId');

-- Add-ons: modifier → group → dish → brand.
UPDATE "recipes" r SET "tenantId" = c."tenantId"
  FROM "modifiers" mo JOIN "modifier_groups" g ON g.id = mo."groupId" JOIN "menu_items" m ON m.id = g."menuItemId" JOIN "concepts" c ON c.id = m."conceptId"
 WHERE r."kind" = 'modifier' AND r."modifierId" = mo.id AND r."tenantId" IS NULL;

-- Sub-recipes: the companies of the dishes / add-ons above them (any depth), their own stock, their creator.
CREATE TEMP TABLE _sub_users AS
WITH RECURSIVE up(comp_id, parent_id) AS (
  SELECT ri."prepRecipeId", ri."recipeId" FROM "recipe_ingredients" ri WHERE ri."prepRecipeId" IS NOT NULL
  UNION
  SELECT up.comp_id, ri."recipeId" FROM up JOIN "recipe_ingredients" ri ON ri."prepRecipeId" = up.parent_id
)
SELECT DISTINCT up.comp_id, p."tenantId"
  FROM up JOIN "recipes" p ON p.id = up.parent_id
 WHERE p."kind" IN ('plate', 'modifier') AND p."tenantId" IS NOT NULL;

UPDATE "recipes" r SET "tenantId" = u.t
  FROM (SELECT comp_id, MIN("tenantId") AS t FROM _sub_users GROUP BY comp_id HAVING COUNT(DISTINCT "tenantId") = 1) u
 WHERE r.id = u.comp_id AND r."kind" = 'component' AND r."tenantId" IS NULL;

UPDATE "recipes" r SET "tenantId" = s.t
  FROM (SELECT ri."recipeId", MIN(i."tenantId") AS t
          FROM "recipe_ingredients" ri JOIN "inventory_items" i ON i.id = ri."inventoryItemId"
         WHERE i."tenantId" IS NOT NULL
         GROUP BY ri."recipeId" HAVING COUNT(DISTINCT i."tenantId") = 1) s
 WHERE r.id = s."recipeId" AND r."kind" = 'component' AND r."tenantId" IS NULL
   AND NOT EXISTS (SELECT 1 FROM _sub_users u WHERE u.comp_id = r.id);

UPDATE "recipes" r SET "tenantId" = usr."tenantId"
  FROM "users" usr
 WHERE r."kind" = 'component' AND r."tenantId" IS NULL AND r."createdById" = usr.id AND usr."tenantId" IS NOT NULL
   AND (NOT EXISTS (SELECT 1 FROM _sub_users u WHERE u.comp_id = r.id)
        OR EXISTS (SELECT 1 FROM _sub_users u WHERE u.comp_id = r.id AND u."tenantId" = usr."tenantId"));
DROP TABLE _sub_users;
