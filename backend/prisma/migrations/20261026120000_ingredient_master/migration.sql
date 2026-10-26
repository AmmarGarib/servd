-- Kitchen flow, part A (owner, 2026-10-26): the ingredient master is SERVD-WIDE (K1). One definition per ingredient
-- (unit, category, allergens, yield %, buying unit + factor, spec); each company's stock item links to it and keeps its
-- own price, supplier, par and stock. Deliberately NO tenantId on ingredient_masters (platform data) — and so no RLS.
--
-- Backfill (below): EVERY ingredient already entered — every non-prep stock item of every company (company-less and
-- Trash-parked ones a recipe still names included) and every recipe line on them is linked to a master. Prep items
-- (kind 'prep') are never master rows. The counts are printed at the end (RAISE NOTICE).

CREATE TABLE "ingredient_masters" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "stockUnit" TEXT NOT NULL,
    "category" TEXT,
    "allergens" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "yieldPct" DOUBLE PRECISION NOT NULL DEFAULT 100,
    "purchaseUnit" TEXT,
    "purchaseUnitFactor" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "spec" TEXT,
    "specFields" JSONB,
    "status" TEXT NOT NULL DEFAULT 'approved',
    "createdByUserId" TEXT,
    "createdInTenantId" TEXT,
    "mergedIntoId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ingredient_masters_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ingredient_masters_normalizedName_idx" ON "ingredient_masters"("normalizedName");
CREATE INDEX "ingredient_masters_status_idx" ON "ingredient_masters"("status");

ALTER TABLE "inventory_items" ADD COLUMN "masterIngredientId" TEXT;
CREATE INDEX "inventory_items_masterIngredientId_idx" ON "inventory_items"("masterIngredientId");
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_masterIngredientId_fkey" FOREIGN KEY ("masterIngredientId") REFERENCES "ingredient_masters"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The ONE normalise rule (lib/ingredientMaster.ts cleanIngredientName / normalizeIngredientName / normalizeUnit /
-- unitFamily — keep both copies identical): JS `\s` whitespace trimmed and collapsed, lower case; units grouped into
-- families with a base unit (g / ml / pcs; anything else its own family), so kg / g twins are ONE master.
CREATE FUNCTION pg_temp.im_clean(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $f$
  SELECT regexp_replace(regexp_replace(t, '^[\t\n\v\f\r    -     　﻿]+|[\t\n\v\f\r    -     　﻿]+$', '', 'g'), '[\t\n\v\f\r    -     　﻿]+', ' ', 'g')
$f$;
CREATE FUNCTION pg_temp.im_norm(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $f$ SELECT lower(pg_temp.im_clean(t)) $f$;
CREATE FUNCTION pg_temp.im_unit(u text) RETURNS text LANGUAGE sql IMMUTABLE AS $f$
  SELECT lower(regexp_replace(u, '^[\t\n\v\f\r    -     　﻿]+|[\t\n\v\f\r    -     　﻿]+$', '', 'g'))
$f$;
CREATE FUNCTION pg_temp.im_base(u text) RETURNS text LANGUAGE sql IMMUTABLE AS $f$
  SELECT CASE WHEN pg_temp.im_unit(u) IN ('mg','g','gm','gms','gr','gram','grams','kg','kgs','kilo','kilos','kilogram','kilograms') THEN 'g'
              WHEN pg_temp.im_unit(u) IN ('ml','millilitre','millilitres','milliliter','milliliters','l','lt','ltr','ltrs','litre','litres','liter','liters') THEN 'ml'
              WHEN pg_temp.im_unit(u) IN ('pcs','pc','piece','pieces','unit','units','each','ea','no','nos','dozen','doz','dz') THEN 'pcs'
              ELSE pg_temp.im_unit(u) END
$f$;
CREATE FUNCTION pg_temp.im_per(u text) RETURNS double precision LANGUAGE sql IMMUTABLE AS $f$
  SELECT CASE WHEN pg_temp.im_unit(u) = 'mg' THEN 0.001
              WHEN pg_temp.im_unit(u) IN ('kg','kgs','kilo','kilos','kilogram','kilograms','l','lt','ltr','ltrs','litre','litres','liter','liters') THEN 1000
              WHEN pg_temp.im_unit(u) IN ('dozen','doz','dz') THEN 12
              ELSE 1 END
$f$;

-- Backfill (owner, 2026-10-26: "cover every ingredient already entered"). Candidates: every non-prep stock item that
-- is live, plus any item (even parked in the Trash) a recipe line still names; company-less items included.
CREATE TEMP TABLE _im_items AS
SELECT i.id, i."tenantId", i."deletedAt", i."createdAt", i.category, i.allergens, i."yieldPct", i."purchaseUnit",
       i."purchaseUnitFactor" * pg_temp.im_per(i.unit) AS "baseFactor",
       pg_temp.im_clean(i.name) AS clean, pg_temp.im_norm(i.name) AS nn, pg_temp.im_base(i.unit) AS nu,
       0 AS dup
  FROM "inventory_items" i
 WHERE i."kind" <> 'prep' AND pg_temp.im_clean(i.name) <> '' AND pg_temp.im_unit(i.unit) <> ''
   AND (i."deletedAt" IS NULL OR EXISTS (SELECT 1 FROM "recipe_ingredients" ri WHERE ri."inventoryItemId" = i.id));

-- A second live item of the same name in a unit of the same family in ONE company (a legacy duplicate) cannot share
-- the master (one stock item per master per company): it gets its own master "<name> (duplicate 2)" … marked
-- needs_review — a reviewer merges it into the right one once the company has merged the two stock items
-- (MERGE_NEEDS_STOCK_MERGE). Never automatic.
UPDATE _im_items t SET dup = r.rn - 1
  FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY "tenantId", nn, nu ORDER BY "createdAt", id) AS rn
          FROM _im_items WHERE "deletedAt" IS NULL AND "tenantId" IS NOT NULL) r
 WHERE t.id = r.id AND r.rn > 1;

INSERT INTO "ingredient_masters" ("id", "name", "normalizedName", "stockUnit", "category", "allergens", "yieldPct", "purchaseUnit", "purchaseUnitFactor", "status", "createdInTenantId", "createdAt", "updatedAt")
SELECT DISTINCT ON (x.nn, x.nu, x.dup)
       md5('ingredient_master:' || x.nn || '|' || x.nu || CASE WHEN x.dup > 0 THEN '|' || x.dup ELSE '' END),
       x.clean || CASE WHEN x.dup > 0 THEN ' (duplicate ' || (x.dup + 1) || ')' ELSE '' END,
       x.nn || CASE WHEN x.dup > 0 THEN ' (duplicate ' || (x.dup + 1) || ')' ELSE '' END,
       x.nu, x.category, x.allergens, x."yieldPct", x."purchaseUnit", x."baseFactor",
       CASE WHEN x.dup > 0 THEN 'needs_review' ELSE 'approved' END, x."tenantId", now(), now()
  FROM _im_items x
 ORDER BY x.nn, x.nu, x.dup, (x."deletedAt" IS NOT NULL), (x."tenantId" IS NULL), x."createdAt", x.id;

UPDATE "inventory_items" i SET "masterIngredientId" = md5('ingredient_master:' || t.nn || '|' || t.nu || CASE WHEN t.dup > 0 THEN '|' || t.dup ELSE '' END)
  FROM _im_items t WHERE i.id = t.id;

-- Recipe lines name their master (K4: a shared recipe resolves each line to the using company's own item).
ALTER TABLE "recipe_ingredients" ADD COLUMN "masterIngredientId" TEXT;
CREATE INDEX "recipe_ingredients_masterIngredientId_idx" ON "recipe_ingredients"("masterIngredientId");
UPDATE "recipe_ingredients" ri SET "masterIngredientId" = i."masterIngredientId"
  FROM "inventory_items" i WHERE ri."inventoryItemId" = i.id AND i."masterIngredientId" IS NOT NULL;

-- The counts (shown by migrate deploy): masters made, items linked, recipe lines linked, and what is left and why.
DO $do$
DECLARE
  masters int; dups int; items int; lines int; prep_lines int; blank_items int; other_items int;
BEGIN
  SELECT COUNT(*) INTO masters FROM "ingredient_masters";
  SELECT COUNT(*) INTO dups FROM "ingredient_masters" WHERE "status" = 'needs_review';
  SELECT COUNT(*) INTO items FROM "inventory_items" WHERE "masterIngredientId" IS NOT NULL;
  SELECT COUNT(*) INTO lines FROM "recipe_ingredients" WHERE "masterIngredientId" IS NOT NULL;
  SELECT COUNT(*) INTO prep_lines FROM "recipe_ingredients" ri JOIN "inventory_items" i ON i.id = ri."inventoryItemId" WHERE ri."masterIngredientId" IS NULL;
  SELECT COUNT(*) INTO blank_items FROM "inventory_items" WHERE "kind" <> 'prep' AND "deletedAt" IS NULL AND "masterIngredientId" IS NULL;
  SELECT COUNT(*) INTO other_items FROM "inventory_items" WHERE "kind" = 'prep';
  RAISE NOTICE 'ingredient master: % masters created (% duplicates for review), % stock items linked, % recipe lines linked', masters, dups, items, lines;
  RAISE NOTICE 'ingredient master: left unlinked — % recipe lines on a prep or blank-named item, % live stock items with a blank name or unit, % prep items (never master rows)', prep_lines, blank_items, other_items;
END
$do$;
DROP TABLE _im_items;
DROP FUNCTION pg_temp.im_per(text);
DROP FUNCTION pg_temp.im_base(text);
DROP FUNCTION pg_temp.im_unit(text);
DROP FUNCTION pg_temp.im_norm(text);
DROP FUNCTION pg_temp.im_clean(text);

-- ─── SQL-only objects (tests/setup.ts applies this section; no ';' inside a statement)
CREATE UNIQUE INDEX "ingredient_masters_name_unit_live_key" ON "ingredient_masters" ("normalizedName", lower("stockUnit")) WHERE "mergedIntoId" IS NULL;
CREATE UNIQUE INDEX "inventory_items_tenant_master_live_key" ON "inventory_items" ("tenantId", "masterIngredientId") WHERE "deletedAt" IS NULL AND "masterIngredientId" IS NOT NULL;
ALTER TABLE "ingredient_masters" ADD CONSTRAINT "ingredient_masters_status_chk" CHECK ("status" IN ('approved', 'needs_review'));
ALTER TABLE "ingredient_masters" ADD CONSTRAINT "ingredient_masters_factor_chk" CHECK ("purchaseUnitFactor" > 0);
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_master_not_prep_chk" CHECK ("masterIngredientId" IS NULL OR "kind" = 'stock');
