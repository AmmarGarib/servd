-- Renames on the Ingredients sheet now reach every company's linked stock item (owner, 2026-11-12: "I pick birds eye
-- chili from the list and it inputs red Onion"). Catch up the items left behind by earlier renames: a live item linked
-- to an ingredient whose name is one of that ingredient's EARLIER names (from the rename audit trail) takes its current
-- name — unless the company already has another live item of that name.
UPDATE inventory_items i
   SET name = m.name, "updatedAt" = now()
  FROM ingredient_masters m
 WHERE i."masterIngredientId" = m.id
   AND i."deletedAt" IS NULL
   AND lower(i.name) <> lower(m.name)
   AND EXISTS (
     SELECT 1 FROM audit_logs a
      WHERE a.action = 'ingredient_master.update' AND a."entityId" = m.id
        AND lower(a.before->>'name') = lower(i.name)
        AND lower(a.before->>'name') <> lower(a.after->>'name'))
   AND NOT EXISTS (
     SELECT 1 FROM inventory_items o
      WHERE o."tenantId" IS NOT DISTINCT FROM i."tenantId" AND o.id <> i.id AND o."deletedAt" IS NULL
        AND lower(o.name) = lower(m.name));
