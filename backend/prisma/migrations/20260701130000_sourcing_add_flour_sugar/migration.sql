-- Basic baking staples that were missing from the shared sourcing master sheet.
-- Same shape/idempotency as 20260630120000_shared_inventory_from_sheet: shared
-- (tenantId NULL), priced per gram in paisa, skipped if the name already exists.
INSERT INTO "inventory_items" (id, name, unit, "unitCostCents", notes, "tenantId", "updatedAt", "parLevel", "currentStock", "yieldPct", allergens)
SELECT gen_random_uuid()::text, v.name, v.unit, v.cost, v.notes, NULL, now(), 0, 0, 100, v.allergens
FROM (VALUES
  ('Flour (All-Purpose / Maida)', 'g', 15, 'YEAR-ROUND · Punjab, Sindh — refined wheat flour for baking/batters', ARRAY['gluten']::text[]),
  ('Sugar (White, Granulated)', 'g', 23, 'YEAR-ROUND · Local sugarcane mills (Punjab/Sindh)', ARRAY[]::text[])
) AS v(name, unit, cost, notes, allergens)
WHERE NOT EXISTS (
  SELECT 1 FROM "inventory_items" i WHERE i.name = v.name AND i."tenantId" IS NULL AND i."deletedAt" IS NULL
);
