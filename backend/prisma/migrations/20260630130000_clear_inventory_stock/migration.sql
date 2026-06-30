-- Clear the Inventory page to a blank slate. Zeroes stock-on-hand and par
-- levels for every item so nothing shows as "tracked" on the Inventory page
-- (which lists only items with stock > 0 or a par level). Non-destructive:
-- no items are deleted, and prices / sourcing-catalog membership / recipe
-- references are untouched — items remain available on the Sourcing Master
-- Sheet and in the recipe picker. Operators re-establish stock by setting a
-- par level or logging stock per item going forward.
UPDATE "inventory_items" SET "parLevel" = 0, "currentStock" = 0;
