-- Convert Flipd's seeded fried-chicken menu to a smash-burger
-- court-side menu, matching the CEO's repositioning (May 30 2026).
-- Soft-deletes the old items so historical orders still reference
-- them, then inserts smash-burger replacements under the same
-- categories. Idempotent: re-running is a no-op.
--
-- Concept ID: e0d15020-6257-4025-a6ef-4578ec6d008f (Flipd)
-- Category IDs (production):
--   Burgers: 11ffa3d4-da39-47fb-8b3b-b4ccf4e17e70
--   Sides:   5b70fe35-5a00-47ef-874a-0debdf4abb09
--   Drinks:  d2b540cc-d6c7-4b8a-a30f-8384227d05ba

UPDATE menu_items
   SET "deletedAt" = NOW()
 WHERE "conceptId" = 'e0d15020-6257-4025-a6ef-4578ec6d008f'
   AND name IN ('Hot Honey Tenders','The Diner Stack','Nashville Hot',
                'Cheesy Tots','Onion Rings','Apple Slaw',
                'Cherry Cola Float','Strawberry Shake','Vanilla Egg Cream')
   AND "deletedAt" IS NULL;

-- Burgers
INSERT INTO menu_items (id, "conceptId", "categoryId", name, description, "priceCents", "displayOrder", "isAvailable", "taxClassification", "createdAt", "updatedAt")
SELECT gen_random_uuid(), 'e0d15020-6257-4025-a6ef-4578ec6d008f', '11ffa3d4-da39-47fb-8b3b-b4ccf4e17e70', 'The Court Classic', 'Single smash, aged cheddar, smash sauce, toasted brioche.', 120000, 1, true, 'standard', NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM menu_items WHERE "conceptId" = 'e0d15020-6257-4025-a6ef-4578ec6d008f' AND name = 'The Court Classic' AND "deletedAt" IS NULL);

INSERT INTO menu_items (id, "conceptId", "categoryId", name, description, "priceCents", "displayOrder", "isAvailable", "taxClassification", "createdAt", "updatedAt")
SELECT gen_random_uuid(), 'e0d15020-6257-4025-a6ef-4578ec6d008f', '11ffa3d4-da39-47fb-8b3b-b4ccf4e17e70', 'Double Smash', 'Two patties, double cheddar, pickles, smash sauce.', 150000, 2, true, 'standard', NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM menu_items WHERE "conceptId" = 'e0d15020-6257-4025-a6ef-4578ec6d008f' AND name = 'Double Smash' AND "deletedAt" IS NULL);

INSERT INTO menu_items (id, "conceptId", "categoryId", name, description, "priceCents", "displayOrder", "isAvailable", "taxClassification", "createdAt", "updatedAt")
SELECT gen_random_uuid(), 'e0d15020-6257-4025-a6ef-4578ec6d008f', '11ffa3d4-da39-47fb-8b3b-b4ccf4e17e70', 'Bacon Smash', 'Double smash, candied bacon, smoked gouda, caramelised onion.', 165000, 3, true, 'standard', NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM menu_items WHERE "conceptId" = 'e0d15020-6257-4025-a6ef-4578ec6d008f' AND name = 'Bacon Smash' AND "deletedAt" IS NULL);

-- Sides
INSERT INTO menu_items (id, "conceptId", "categoryId", name, description, "priceCents", "displayOrder", "isAvailable", "taxClassification", "createdAt", "updatedAt")
SELECT gen_random_uuid(), 'e0d15020-6257-4025-a6ef-4578ec6d008f', '5b70fe35-5a00-47ef-874a-0debdf4abb09', 'Hand-cut Fries', 'Skin-on, twice-fried, sea salt.', 50000, 1, true, 'standard', NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM menu_items WHERE "conceptId" = 'e0d15020-6257-4025-a6ef-4578ec6d008f' AND name = 'Hand-cut Fries' AND "deletedAt" IS NULL);

INSERT INTO menu_items (id, "conceptId", "categoryId", name, description, "priceCents", "displayOrder", "isAvailable", "taxClassification", "createdAt", "updatedAt")
SELECT gen_random_uuid(), 'e0d15020-6257-4025-a6ef-4578ec6d008f', '5b70fe35-5a00-47ef-874a-0debdf4abb09', 'Smash Sauce Wings', 'Six wings, smash-sauce glaze, scallion.', 85000, 2, true, 'standard', NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM menu_items WHERE "conceptId" = 'e0d15020-6257-4025-a6ef-4578ec6d008f' AND name = 'Smash Sauce Wings' AND "deletedAt" IS NULL);

INSERT INTO menu_items (id, "conceptId", "categoryId", name, description, "priceCents", "displayOrder", "isAvailable", "taxClassification", "createdAt", "updatedAt")
SELECT gen_random_uuid(), 'e0d15020-6257-4025-a6ef-4578ec6d008f', '5b70fe35-5a00-47ef-874a-0debdf4abb09', 'Loaded Fries', 'Hand-cut fries, smash sauce, jalapeno, melted cheddar.', 65000, 3, true, 'standard', NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM menu_items WHERE "conceptId" = 'e0d15020-6257-4025-a6ef-4578ec6d008f' AND name = 'Loaded Fries' AND "deletedAt" IS NULL);

-- Drinks
INSERT INTO menu_items (id, "conceptId", "categoryId", name, description, "priceCents", "displayOrder", "isAvailable", "taxClassification", "createdAt", "updatedAt")
SELECT gen_random_uuid(), 'e0d15020-6257-4025-a6ef-4578ec6d008f', 'd2b540cc-d6c7-4b8a-a30f-8384227d05ba', 'Mango Lassi Shake', 'House-made lassi, mango, cardamom.', 70000, 1, true, 'standard', NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM menu_items WHERE "conceptId" = 'e0d15020-6257-4025-a6ef-4578ec6d008f' AND name = 'Mango Lassi Shake' AND "deletedAt" IS NULL);

INSERT INTO menu_items (id, "conceptId", "categoryId", name, description, "priceCents", "displayOrder", "isAvailable", "taxClassification", "createdAt", "updatedAt")
SELECT gen_random_uuid(), 'e0d15020-6257-4025-a6ef-4578ec6d008f', 'd2b540cc-d6c7-4b8a-a30f-8384227d05ba', 'Iced Lemonade', 'Fresh-squeezed, mint, soda.', 55000, 2, true, 'standard', NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM menu_items WHERE "conceptId" = 'e0d15020-6257-4025-a6ef-4578ec6d008f' AND name = 'Iced Lemonade' AND "deletedAt" IS NULL);

INSERT INTO menu_items (id, "conceptId", "categoryId", name, description, "priceCents", "displayOrder", "isAvailable", "taxClassification", "createdAt", "updatedAt")
SELECT gen_random_uuid(), 'e0d15020-6257-4025-a6ef-4578ec6d008f', 'd2b540cc-d6c7-4b8a-a30f-8384227d05ba', 'Vanilla Bean Shake', 'House-made shake, real vanilla, whipped cream.', 70000, 3, true, 'standard', NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM menu_items WHERE "conceptId" = 'e0d15020-6257-4025-a6ef-4578ec6d008f' AND name = 'Vanilla Bean Shake' AND "deletedAt" IS NULL);

-- Tidy up: rename Flipd's "Burgers" category description-wise — no
-- column to update, so skip. Also overwrite the concept description
-- with the new positioning if it still matches the chicken text.
UPDATE concepts
   SET description = 'Smash burgers at the padel court — dry-aged beef on the cast-iron, brioche court-side.'
 WHERE id = 'e0d15020-6257-4025-a6ef-4578ec6d008f'
   AND ("description" IS NULL
        OR "description" ILIKE '%fried chicken%'
        OR "description" ILIKE '%diner-style%'
        OR "description" ILIKE '%buttermilk%');
