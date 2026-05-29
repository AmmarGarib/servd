-- Stax + Flipd: fix concept descriptions and seed placeholder menu
-- items so the storefront ordering flow has something real to render
-- for both brands. Idempotent: each INSERT is guarded with a
-- WHERE NOT EXISTS on (conceptId, name), and the description UPDATE
-- only fires when the description still matches the old value.
--
-- Stax is plated dine-in (per the operator) — fixing the legacy
-- "Upscale sandwiches and bowls" / "Scratch cooking" descriptions
-- that misrepresent the format. Flipd is the diner-style fried-
-- chicken concept (not a burger kitchen).
--
-- Concept + category UUIDs are the production values pulled live
-- from /api/v1/storefront/concepts.

UPDATE concepts
   SET description = 'Smash-burger dine-in room — dry-aged patties, brioche baked here, house sauces.'
 WHERE id = '9f91de2b-5a31-46b8-b338-35a0172b6468'
   AND ("description" IS NULL OR "description" ILIKE '%sandwich%' OR "description" ILIKE '%bowl%' OR "description" ILIKE '%ghost%' OR "description" ILIKE '%delivery%first%');

UPDATE concepts
   SET description = 'Diner-style fried chicken — buttermilk-brined, hand-breaded, served hot to your booth.'
 WHERE id = 'e0d15020-6257-4025-a6ef-4578ec6d008f'
   AND ("description" IS NULL OR "description" ILIKE '%burger%' OR "description" ILIKE '%upscale burger%');

-- ─── STAX ─────────────────────────────────────────────────────────
-- Burgers (cat 23495f54-f7d6-4e2b-8702-81cf47a333c4)

INSERT INTO menu_items (id, "conceptId", "categoryId", name, description, "priceCents", "displayOrder", "isAvailable", "taxClassification", "createdAt", "updatedAt")
SELECT gen_random_uuid(), '9f91de2b-5a31-46b8-b338-35a0172b6468', '23495f54-f7d6-4e2b-8702-81cf47a333c4', 'The Stax Classic', 'Double smash, aged cheddar, special sauce, brioche.', 180000, 1, true, 'standard', NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM menu_items WHERE "conceptId" = '9f91de2b-5a31-46b8-b338-35a0172b6468' AND name = 'The Stax Classic' AND "deletedAt" IS NULL);

INSERT INTO menu_items (id, "conceptId", "categoryId", name, description, "priceCents", "displayOrder", "isAvailable", "taxClassification", "createdAt", "updatedAt")
SELECT gen_random_uuid(), '9f91de2b-5a31-46b8-b338-35a0172b6468', '23495f54-f7d6-4e2b-8702-81cf47a333c4', 'The Brunch Stax', 'Smash patty, fried egg, candied bacon, hash brown.', 210000, 2, true, 'standard', NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM menu_items WHERE "conceptId" = '9f91de2b-5a31-46b8-b338-35a0172b6468' AND name = 'The Brunch Stax' AND "deletedAt" IS NULL);

INSERT INTO menu_items (id, "conceptId", "categoryId", name, description, "priceCents", "displayOrder", "isAvailable", "taxClassification", "createdAt", "updatedAt")
SELECT gen_random_uuid(), '9f91de2b-5a31-46b8-b338-35a0172b6468', '23495f54-f7d6-4e2b-8702-81cf47a333c4', 'The Truffle', 'Wagyu smash, truffle mayo, brie, caramelised onion.', 280000, 3, true, 'standard', NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM menu_items WHERE "conceptId" = '9f91de2b-5a31-46b8-b338-35a0172b6468' AND name = 'The Truffle' AND "deletedAt" IS NULL);

-- Sides (cat 6a453700-6185-44bd-b39b-9c775476aafd)

INSERT INTO menu_items (id, "conceptId", "categoryId", name, description, "priceCents", "displayOrder", "isAvailable", "taxClassification", "createdAt", "updatedAt")
SELECT gen_random_uuid(), '9f91de2b-5a31-46b8-b338-35a0172b6468', '6a453700-6185-44bd-b39b-9c775476aafd', 'Truffle Fries', 'Hand-cut, truffle oil, shaved parmesan.', 75000, 1, true, 'standard', NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM menu_items WHERE "conceptId" = '9f91de2b-5a31-46b8-b338-35a0172b6468' AND name = 'Truffle Fries' AND "deletedAt" IS NULL);

INSERT INTO menu_items (id, "conceptId", "categoryId", name, description, "priceCents", "displayOrder", "isAvailable", "taxClassification", "createdAt", "updatedAt")
SELECT gen_random_uuid(), '9f91de2b-5a31-46b8-b338-35a0172b6468', '6a453700-6185-44bd-b39b-9c775476aafd', 'Loaded Tots', 'Crispy tots, bacon, cheese sauce, scallion.', 85000, 2, true, 'standard', NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM menu_items WHERE "conceptId" = '9f91de2b-5a31-46b8-b338-35a0172b6468' AND name = 'Loaded Tots' AND "deletedAt" IS NULL);

INSERT INTO menu_items (id, "conceptId", "categoryId", name, description, "priceCents", "displayOrder", "isAvailable", "taxClassification", "createdAt", "updatedAt")
SELECT gen_random_uuid(), '9f91de2b-5a31-46b8-b338-35a0172b6468', '6a453700-6185-44bd-b39b-9c775476aafd', 'Mac & Cheese Bites', 'Golden, gruyere, sriracha aioli.', 70000, 3, true, 'standard', NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM menu_items WHERE "conceptId" = '9f91de2b-5a31-46b8-b338-35a0172b6468' AND name = 'Mac & Cheese Bites' AND "deletedAt" IS NULL);

-- Drinks (cat 5dfa675b-58d4-4608-b048-2625f532b4cc)

INSERT INTO menu_items (id, "conceptId", "categoryId", name, description, "priceCents", "displayOrder", "isAvailable", "taxClassification", "createdAt", "updatedAt")
SELECT gen_random_uuid(), '9f91de2b-5a31-46b8-b338-35a0172b6468', '5dfa675b-58d4-4608-b048-2625f532b4cc', 'Vanilla Bean Shake', 'House-made, real vanilla, whipped cream.', 65000, 1, true, 'standard', NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM menu_items WHERE "conceptId" = '9f91de2b-5a31-46b8-b338-35a0172b6468' AND name = 'Vanilla Bean Shake' AND "deletedAt" IS NULL);

INSERT INTO menu_items (id, "conceptId", "categoryId", name, description, "priceCents", "displayOrder", "isAvailable", "taxClassification", "createdAt", "updatedAt")
SELECT gen_random_uuid(), '9f91de2b-5a31-46b8-b338-35a0172b6468', '5dfa675b-58d4-4608-b048-2625f532b4cc', 'Salted Caramel Frappe', 'Espresso, caramel, oat milk, sea salt.', 70000, 2, true, 'standard', NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM menu_items WHERE "conceptId" = '9f91de2b-5a31-46b8-b338-35a0172b6468' AND name = 'Salted Caramel Frappe' AND "deletedAt" IS NULL);

INSERT INTO menu_items (id, "conceptId", "categoryId", name, description, "priceCents", "displayOrder", "isAvailable", "taxClassification", "createdAt", "updatedAt")
SELECT gen_random_uuid(), '9f91de2b-5a31-46b8-b338-35a0172b6468', '5dfa675b-58d4-4608-b048-2625f532b4cc', 'Hibiscus Cooler', 'Hibiscus, lime, soda.', 55000, 3, true, 'standard', NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM menu_items WHERE "conceptId" = '9f91de2b-5a31-46b8-b338-35a0172b6468' AND name = 'Hibiscus Cooler' AND "deletedAt" IS NULL);

-- ─── FLIPD ────────────────────────────────────────────────────────
-- Burgers (cat 11ffa3d4-da39-47fb-8b3b-b4ccf4e17e70)

INSERT INTO menu_items (id, "conceptId", "categoryId", name, description, "priceCents", "displayOrder", "isAvailable", "taxClassification", "createdAt", "updatedAt")
SELECT gen_random_uuid(), 'e0d15020-6257-4025-a6ef-4578ec6d008f', '11ffa3d4-da39-47fb-8b3b-b4ccf4e17e70', 'Hot Honey Tenders', 'Buttermilk-brined, hand-breaded, hot honey drizzle.', 110000, 1, true, 'standard', NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM menu_items WHERE "conceptId" = 'e0d15020-6257-4025-a6ef-4578ec6d008f' AND name = 'Hot Honey Tenders' AND "deletedAt" IS NULL);

INSERT INTO menu_items (id, "conceptId", "categoryId", name, description, "priceCents", "displayOrder", "isAvailable", "taxClassification", "createdAt", "updatedAt")
SELECT gen_random_uuid(), 'e0d15020-6257-4025-a6ef-4578ec6d008f', '11ffa3d4-da39-47fb-8b3b-b4ccf4e17e70', 'The Diner Stack', 'Crispy chicken cutlet, lettuce, tomato, diner sauce, sesame bun.', 130000, 2, true, 'standard', NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM menu_items WHERE "conceptId" = 'e0d15020-6257-4025-a6ef-4578ec6d008f' AND name = 'The Diner Stack' AND "deletedAt" IS NULL);

INSERT INTO menu_items (id, "conceptId", "categoryId", name, description, "priceCents", "displayOrder", "isAvailable", "taxClassification", "createdAt", "updatedAt")
SELECT gen_random_uuid(), 'e0d15020-6257-4025-a6ef-4578ec6d008f', '11ffa3d4-da39-47fb-8b3b-b4ccf4e17e70', 'Nashville Hot', 'Cayenne-bathed, dill pickle, white bread.', 120000, 3, true, 'standard', NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM menu_items WHERE "conceptId" = 'e0d15020-6257-4025-a6ef-4578ec6d008f' AND name = 'Nashville Hot' AND "deletedAt" IS NULL);

-- Sides (cat 5b70fe35-5a00-47ef-874a-0debdf4abb09)

INSERT INTO menu_items (id, "conceptId", "categoryId", name, description, "priceCents", "displayOrder", "isAvailable", "taxClassification", "createdAt", "updatedAt")
SELECT gen_random_uuid(), 'e0d15020-6257-4025-a6ef-4578ec6d008f', '5b70fe35-5a00-47ef-874a-0debdf4abb09', 'Cheesy Tots', 'Golden tots, melted American cheese.', 60000, 1, true, 'standard', NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM menu_items WHERE "conceptId" = 'e0d15020-6257-4025-a6ef-4578ec6d008f' AND name = 'Cheesy Tots' AND "deletedAt" IS NULL);

INSERT INTO menu_items (id, "conceptId", "categoryId", name, description, "priceCents", "displayOrder", "isAvailable", "taxClassification", "createdAt", "updatedAt")
SELECT gen_random_uuid(), 'e0d15020-6257-4025-a6ef-4578ec6d008f', '5b70fe35-5a00-47ef-874a-0debdf4abb09', 'Onion Rings', 'Beer-battered, buttermilk ranch.', 55000, 2, true, 'standard', NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM menu_items WHERE "conceptId" = 'e0d15020-6257-4025-a6ef-4578ec6d008f' AND name = 'Onion Rings' AND "deletedAt" IS NULL);

INSERT INTO menu_items (id, "conceptId", "categoryId", name, description, "priceCents", "displayOrder", "isAvailable", "taxClassification", "createdAt", "updatedAt")
SELECT gen_random_uuid(), 'e0d15020-6257-4025-a6ef-4578ec6d008f', '5b70fe35-5a00-47ef-874a-0debdf4abb09', 'Apple Slaw', 'Apple, red cabbage, buttermilk-mustard dressing.', 40000, 3, true, 'standard', NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM menu_items WHERE "conceptId" = 'e0d15020-6257-4025-a6ef-4578ec6d008f' AND name = 'Apple Slaw' AND "deletedAt" IS NULL);

-- Drinks (cat d2b540cc-d6c7-4b8a-a30f-8384227d05ba)

INSERT INTO menu_items (id, "conceptId", "categoryId", name, description, "priceCents", "displayOrder", "isAvailable", "taxClassification", "createdAt", "updatedAt")
SELECT gen_random_uuid(), 'e0d15020-6257-4025-a6ef-4578ec6d008f', 'd2b540cc-d6c7-4b8a-a30f-8384227d05ba', 'Cherry Cola Float', 'Vanilla ice cream, cherry cola.', 65000, 1, true, 'standard', NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM menu_items WHERE "conceptId" = 'e0d15020-6257-4025-a6ef-4578ec6d008f' AND name = 'Cherry Cola Float' AND "deletedAt" IS NULL);

INSERT INTO menu_items (id, "conceptId", "categoryId", name, description, "priceCents", "displayOrder", "isAvailable", "taxClassification", "createdAt", "updatedAt")
SELECT gen_random_uuid(), 'e0d15020-6257-4025-a6ef-4578ec6d008f', 'd2b540cc-d6c7-4b8a-a30f-8384227d05ba', 'Strawberry Shake', 'Fresh strawberries, whipped cream, cherry on top.', 70000, 2, true, 'standard', NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM menu_items WHERE "conceptId" = 'e0d15020-6257-4025-a6ef-4578ec6d008f' AND name = 'Strawberry Shake' AND "deletedAt" IS NULL);

INSERT INTO menu_items (id, "conceptId", "categoryId", name, description, "priceCents", "displayOrder", "isAvailable", "taxClassification", "createdAt", "updatedAt")
SELECT gen_random_uuid(), 'e0d15020-6257-4025-a6ef-4578ec6d008f', 'd2b540cc-d6c7-4b8a-a30f-8384227d05ba', 'Vanilla Egg Cream', 'Old-school soda-fountain classic.', 55000, 3, true, 'standard', NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM menu_items WHERE "conceptId" = 'e0d15020-6257-4025-a6ef-4578ec6d008f' AND name = 'Vanilla Egg Cream' AND "deletedAt" IS NULL);
