-- Stax menu rebuild — replace the placeholder menu (Burgers / Sides / Drinks)
-- with the real category structure: Smash Stax, Pub Stax, Flaky Stax, Golden
-- Stax, Stacked Bowls, Side Stax, Stacked Desserts.
--
-- Per the operator: prices aren't set yet, so every item goes in at PKR 0 and
-- VISIBLE — they'll be priced in the admin Menu editor. The previous
-- placeholder categories + items are soft-deleted (deletedAt) so order history
-- / FK references stay intact.
--
-- Concept: 9f91de2b-5a31-46b8-b338-35a0172b6468 (Stax)
--
-- Flaky Stax + Golden Stax have no real items in the source spec yet (the rows
-- read "place holder info for now"), so the categories are created empty rather
-- than pushing placeholder text to the storefront. Dessert items whose
-- descriptions are still TBD go in with names only (NULL description).

-- ─── 1. Retire the existing placeholder menu (soft delete) ──────────────────
-- Everything currently live under Stax is placeholder data — clear it before
-- inserting the new structure. Soft delete only (no hard delete) so any
-- order_items pointing at these rows keep resolving.

UPDATE menu_items
   SET "isAvailable" = false,
       "deletedAt"   = NOW(),
       "updatedAt"   = NOW()
 WHERE "conceptId" = '9f91de2b-5a31-46b8-b338-35a0172b6468'
   AND "deletedAt" IS NULL;

UPDATE categories
   SET "isActive"  = false,
       "deletedAt" = NOW(),
       "updatedAt" = NOW()
 WHERE "conceptId" = '9f91de2b-5a31-46b8-b338-35a0172b6468'
   AND "deletedAt" IS NULL;

-- ─── 2. Create the new categories ──────────────────────────────────────────
-- Fixed UUIDs so the item inserts below can reference them directly. Idempotent
-- on (conceptId, name) against live (non-deleted) rows.

INSERT INTO categories (id, "conceptId", name, "sortOrder", "isActive", "createdAt", "updatedAt")
SELECT 'b28bb390-f3ff-407b-9e3d-3a8a311e1616', '9f91de2b-5a31-46b8-b338-35a0172b6468', 'Smash Stax', 1, true, NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM categories WHERE "conceptId" = '9f91de2b-5a31-46b8-b338-35a0172b6468' AND name = 'Smash Stax' AND "deletedAt" IS NULL);

INSERT INTO categories (id, "conceptId", name, "sortOrder", "isActive", "createdAt", "updatedAt")
SELECT 'e4fc1fdb-8394-4f59-ad53-5660ef21c980', '9f91de2b-5a31-46b8-b338-35a0172b6468', 'Pub Stax', 2, true, NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM categories WHERE "conceptId" = '9f91de2b-5a31-46b8-b338-35a0172b6468' AND name = 'Pub Stax' AND "deletedAt" IS NULL);

INSERT INTO categories (id, "conceptId", name, "sortOrder", "isActive", "createdAt", "updatedAt")
SELECT '11b9ca67-915c-4c87-ad35-fb5677dce841', '9f91de2b-5a31-46b8-b338-35a0172b6468', 'Flaky Stax', 3, true, NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM categories WHERE "conceptId" = '9f91de2b-5a31-46b8-b338-35a0172b6468' AND name = 'Flaky Stax' AND "deletedAt" IS NULL);

INSERT INTO categories (id, "conceptId", name, "sortOrder", "isActive", "createdAt", "updatedAt")
SELECT 'be8646e0-b740-412e-8196-682e3d5a76c5', '9f91de2b-5a31-46b8-b338-35a0172b6468', 'Golden Stax', 4, true, NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM categories WHERE "conceptId" = '9f91de2b-5a31-46b8-b338-35a0172b6468' AND name = 'Golden Stax' AND "deletedAt" IS NULL);

INSERT INTO categories (id, "conceptId", name, "sortOrder", "isActive", "createdAt", "updatedAt")
SELECT 'c61c78d5-4350-4c4c-8b0f-573a6f6237ca', '9f91de2b-5a31-46b8-b338-35a0172b6468', 'Stacked Bowls', 5, true, NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM categories WHERE "conceptId" = '9f91de2b-5a31-46b8-b338-35a0172b6468' AND name = 'Stacked Bowls' AND "deletedAt" IS NULL);

INSERT INTO categories (id, "conceptId", name, "sortOrder", "isActive", "createdAt", "updatedAt")
SELECT '7bce1a35-2a12-487a-8a46-130a7a13730b', '9f91de2b-5a31-46b8-b338-35a0172b6468', 'Side Stax', 6, true, NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM categories WHERE "conceptId" = '9f91de2b-5a31-46b8-b338-35a0172b6468' AND name = 'Side Stax' AND "deletedAt" IS NULL);

INSERT INTO categories (id, "conceptId", name, "sortOrder", "isActive", "createdAt", "updatedAt")
SELECT '7e349780-a2b1-4d24-9752-1f0cefe540d0', '9f91de2b-5a31-46b8-b338-35a0172b6468', 'Stacked Desserts', 7, true, NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM categories WHERE "conceptId" = '9f91de2b-5a31-46b8-b338-35a0172b6468' AND name = 'Stacked Desserts' AND "deletedAt" IS NULL);

-- ─── 3. Insert the new menu items (PKR 0, visible) ─────────────────────────
-- Idempotent on (conceptId, categoryId, name) against live rows. priceCents = 0
-- by design — operator prices these in the Menu editor.

-- Smash Stax — HOUSE MADE BRIOCHE | SMASH PATTY (cat b28bb390…)
INSERT INTO menu_items (id, "conceptId", "categoryId", name, description, "priceCents", "displayOrder", "isAvailable", "taxClassification", "createdAt", "updatedAt")
SELECT gen_random_uuid(), '9f91de2b-5a31-46b8-b338-35a0172b6468', 'b28bb390-f3ff-407b-9e3d-3a8a311e1616', 'MCD Stack', 'House made Brioche, Double Smash Patty, Ketchup, House Mustard, Diced White Onion, Pickles', 0, 1, true, 'standard', NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM menu_items WHERE "conceptId" = '9f91de2b-5a31-46b8-b338-35a0172b6468' AND "categoryId" = 'b28bb390-f3ff-407b-9e3d-3a8a311e1616' AND name = 'MCD Stack' AND "deletedAt" IS NULL);

INSERT INTO menu_items (id, "conceptId", "categoryId", name, description, "priceCents", "displayOrder", "isAvailable", "taxClassification", "createdAt", "updatedAt")
SELECT gen_random_uuid(), '9f91de2b-5a31-46b8-b338-35a0172b6468', 'b28bb390-f3ff-407b-9e3d-3a8a311e1616', 'Smash Stack', 'House made Brioche, Double Smash Patty, Signature Seasonal Sauce', 0, 2, true, 'standard', NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM menu_items WHERE "conceptId" = '9f91de2b-5a31-46b8-b338-35a0172b6468' AND "categoryId" = 'b28bb390-f3ff-407b-9e3d-3a8a311e1616' AND name = 'Smash Stack' AND "deletedAt" IS NULL);

-- Pub Stax — HOUSE MADE BRIOCHE | THICC CHAR-GRILLED PATTY (cat e4fc1fdb…)
INSERT INTO menu_items (id, "conceptId", "categoryId", name, description, "priceCents", "displayOrder", "isAvailable", "taxClassification", "createdAt", "updatedAt")
SELECT gen_random_uuid(), '9f91de2b-5a31-46b8-b338-35a0172b6468', 'e4fc1fdb-8394-4f59-ad53-5660ef21c980', 'MCD Stack', 'House made Brioche, Double Smash Patty, Ketchup, House Mustard, Diced White Onion, Pickles', 0, 1, true, 'standard', NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM menu_items WHERE "conceptId" = '9f91de2b-5a31-46b8-b338-35a0172b6468' AND "categoryId" = 'e4fc1fdb-8394-4f59-ad53-5660ef21c980' AND name = 'MCD Stack' AND "deletedAt" IS NULL);

INSERT INTO menu_items (id, "conceptId", "categoryId", name, description, "priceCents", "displayOrder", "isAvailable", "taxClassification", "createdAt", "updatedAt")
SELECT gen_random_uuid(), '9f91de2b-5a31-46b8-b338-35a0172b6468', 'e4fc1fdb-8394-4f59-ad53-5660ef21c980', 'Smash Stack', 'House made Brioche, Double Smash Patty, Signature Seasonal Sauce', 0, 2, true, 'standard', NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM menu_items WHERE "conceptId" = '9f91de2b-5a31-46b8-b338-35a0172b6468' AND "categoryId" = 'e4fc1fdb-8394-4f59-ad53-5660ef21c980' AND name = 'Smash Stack' AND "deletedAt" IS NULL);

INSERT INTO menu_items (id, "conceptId", "categoryId", name, description, "priceCents", "displayOrder", "isAvailable", "taxClassification", "createdAt", "updatedAt")
SELECT gen_random_uuid(), '9f91de2b-5a31-46b8-b338-35a0172b6468', 'e4fc1fdb-8394-4f59-ad53-5660ef21c980', 'C Stack', 'House made Brioche, Rice and Tapioca Fried Chicken, Signature Seasonal Sauce', 0, 3, true, 'standard', NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM menu_items WHERE "conceptId" = '9f91de2b-5a31-46b8-b338-35a0172b6468' AND "categoryId" = 'e4fc1fdb-8394-4f59-ad53-5660ef21c980' AND name = 'C Stack' AND "deletedAt" IS NULL);

INSERT INTO menu_items (id, "conceptId", "categoryId", name, description, "priceCents", "displayOrder", "isAvailable", "taxClassification", "createdAt", "updatedAt")
SELECT gen_random_uuid(), '9f91de2b-5a31-46b8-b338-35a0172b6468', 'e4fc1fdb-8394-4f59-ad53-5660ef21c980', 'CC Stack', 'House made Brioche, Double Stack Rice and Tapioca Fried Chicken Cutlet, Signature Seasonal Sauce', 0, 4, true, 'standard', NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM menu_items WHERE "conceptId" = '9f91de2b-5a31-46b8-b338-35a0172b6468' AND "categoryId" = 'e4fc1fdb-8394-4f59-ad53-5660ef21c980' AND name = 'CC Stack' AND "deletedAt" IS NULL);

-- Stacked Bowls — Chef Driven Bowls (cat c61c78d5…)
INSERT INTO menu_items (id, "conceptId", "categoryId", name, description, "priceCents", "displayOrder", "isAvailable", "taxClassification", "createdAt", "updatedAt")
SELECT gen_random_uuid(), '9f91de2b-5a31-46b8-b338-35a0172b6468', 'c61c78d5-4350-4c4c-8b0f-573a6f6237ca', 'Burmese Noodle Bowl', 'Khaosway Sauce, Chicken, House Made Tagliatelle', 0, 1, true, 'standard', NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM menu_items WHERE "conceptId" = '9f91de2b-5a31-46b8-b338-35a0172b6468' AND "categoryId" = 'c61c78d5-4350-4c4c-8b0f-573a6f6237ca' AND name = 'Burmese Noodle Bowl' AND "deletedAt" IS NULL);

INSERT INTO menu_items (id, "conceptId", "categoryId", name, description, "priceCents", "displayOrder", "isAvailable", "taxClassification", "createdAt", "updatedAt")
SELECT gen_random_uuid(), '9f91de2b-5a31-46b8-b338-35a0172b6468', 'c61c78d5-4350-4c4c-8b0f-573a6f6237ca', 'Hainanese Chicken Rice', 'Poached Chicken, Chicken Rice, Spicy Sauce, Tangy Sauce', 0, 2, true, 'standard', NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM menu_items WHERE "conceptId" = '9f91de2b-5a31-46b8-b338-35a0172b6468' AND "categoryId" = 'c61c78d5-4350-4c4c-8b0f-573a6f6237ca' AND name = 'Hainanese Chicken Rice' AND "deletedAt" IS NULL);

-- Side Stax — Sides (cat 7bce1a35…)
INSERT INTO menu_items (id, "conceptId", "categoryId", name, description, "priceCents", "displayOrder", "isAvailable", "taxClassification", "createdAt", "updatedAt")
SELECT gen_random_uuid(), '9f91de2b-5a31-46b8-b338-35a0172b6468', '7bce1a35-2a12-487a-8a46-130a7a13730b', 'Pommes Stax', 'Bake Layered Potato + Fat in Hotel Pan, Press and Set Overnight, Cut before service, Fry A la Minute', 0, 1, true, 'standard', NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM menu_items WHERE "conceptId" = '9f91de2b-5a31-46b8-b338-35a0172b6468' AND "categoryId" = '7bce1a35-2a12-487a-8a46-130a7a13730b' AND name = 'Pommes Stax' AND "deletedAt" IS NULL);

INSERT INTO menu_items (id, "conceptId", "categoryId", name, description, "priceCents", "displayOrder", "isAvailable", "taxClassification", "createdAt", "updatedAt")
SELECT gen_random_uuid(), '9f91de2b-5a31-46b8-b338-35a0172b6468', '7bce1a35-2a12-487a-8a46-130a7a13730b', 'Roasties', 'Potato ends boiled and cooled overnight. Roasted or fried a la minute.', 0, 2, true, 'standard', NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM menu_items WHERE "conceptId" = '9f91de2b-5a31-46b8-b338-35a0172b6468' AND "categoryId" = '7bce1a35-2a12-487a-8a46-130a7a13730b' AND name = 'Roasties' AND "deletedAt" IS NULL);

-- Stacked Desserts (cat 7e349780…) — descriptions TBD except Millionaire's.
INSERT INTO menu_items (id, "conceptId", "categoryId", name, description, "priceCents", "displayOrder", "isAvailable", "taxClassification", "createdAt", "updatedAt")
SELECT gen_random_uuid(), '9f91de2b-5a31-46b8-b338-35a0172b6468', '7e349780-a2b1-4d24-9752-1f0cefe540d0', 'Croissant Bread Pudding', NULL, 0, 1, true, 'standard', NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM menu_items WHERE "conceptId" = '9f91de2b-5a31-46b8-b338-35a0172b6468' AND "categoryId" = '7e349780-a2b1-4d24-9752-1f0cefe540d0' AND name = 'Croissant Bread Pudding' AND "deletedAt" IS NULL);

INSERT INTO menu_items (id, "conceptId", "categoryId", name, description, "priceCents", "displayOrder", "isAvailable", "taxClassification", "createdAt", "updatedAt")
SELECT gen_random_uuid(), '9f91de2b-5a31-46b8-b338-35a0172b6468', '7e349780-a2b1-4d24-9752-1f0cefe540d0', 'Lemon Trifle', NULL, 0, 2, true, 'standard', NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM menu_items WHERE "conceptId" = '9f91de2b-5a31-46b8-b338-35a0172b6468' AND "categoryId" = '7e349780-a2b1-4d24-9752-1f0cefe540d0' AND name = 'Lemon Trifle' AND "deletedAt" IS NULL);

INSERT INTO menu_items (id, "conceptId", "categoryId", name, description, "priceCents", "displayOrder", "isAvailable", "taxClassification", "createdAt", "updatedAt")
SELECT gen_random_uuid(), '9f91de2b-5a31-46b8-b338-35a0172b6468', '7e349780-a2b1-4d24-9752-1f0cefe540d0', 'Millionaire''s Shortbread', 'shortbread layer, toffee layer, chocolate mousse layer, sea salt sprinkle', 0, 3, true, 'standard', NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM menu_items WHERE "conceptId" = '9f91de2b-5a31-46b8-b338-35a0172b6468' AND "categoryId" = '7e349780-a2b1-4d24-9752-1f0cefe540d0' AND name = 'Millionaire''s Shortbread' AND "deletedAt" IS NULL);

INSERT INTO menu_items (id, "conceptId", "categoryId", name, description, "priceCents", "displayOrder", "isAvailable", "taxClassification", "createdAt", "updatedAt")
SELECT gen_random_uuid(), '9f91de2b-5a31-46b8-b338-35a0172b6468', '7e349780-a2b1-4d24-9752-1f0cefe540d0', 'Hokaido Cheese Tart', NULL, 0, 4, true, 'standard', NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM menu_items WHERE "conceptId" = '9f91de2b-5a31-46b8-b338-35a0172b6468' AND "categoryId" = '7e349780-a2b1-4d24-9752-1f0cefe540d0' AND name = 'Hokaido Cheese Tart' AND "deletedAt" IS NULL);
