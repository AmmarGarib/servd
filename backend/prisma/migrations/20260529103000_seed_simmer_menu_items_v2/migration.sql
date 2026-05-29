-- Seed placeholder Simmer menu items so /brand/simmer/menu shows a
-- real, addable-to-cart menu before the operator publishes a final
-- one through the admin. Idempotent: each row is inserted only if a
-- non-deleted item with the same name doesn't already exist under
-- Simmer's concept. Re-running the migration is a no-op.
--
-- Concept + category UUIDs are the production values; copy was lifted
-- straight from src/components/brand/layouts/SimmerMenu.tsx so the
-- placeholder content stays consistent between the menu page and the
-- /simmer ordering surface.

-- Small Plates
INSERT INTO menu_items (id, "conceptId", "categoryId", name, description, "priceCents", "displayOrder", "isAvailable", "taxClassification", "createdAt", "updatedAt")
SELECT gen_random_uuid(), '2148ed5a-2e81-43c2-a90d-91c51b40c465', 'd2039125-680b-4aad-bf26-d7670630da99', 'Burrata', 'Blistered tomato, olive oil cracker, basil.', 140000, 1, true, 'standard', NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM menu_items WHERE "conceptId" = '2148ed5a-2e81-43c2-a90d-91c51b40c465' AND name = 'Burrata' AND "deletedAt" IS NULL);

INSERT INTO menu_items (id, "conceptId", "categoryId", name, description, "priceCents", "displayOrder", "isAvailable", "taxClassification", "createdAt", "updatedAt")
SELECT gen_random_uuid(), '2148ed5a-2e81-43c2-a90d-91c51b40c465', 'd2039125-680b-4aad-bf26-d7670630da99', 'Charred octopus', 'Smoked aioli, pickled chilli, lemon.', 165000, 2, true, 'standard', NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM menu_items WHERE "conceptId" = '2148ed5a-2e81-43c2-a90d-91c51b40c465' AND name = 'Charred octopus' AND "deletedAt" IS NULL);

INSERT INTO menu_items (id, "conceptId", "categoryId", name, description, "priceCents", "displayOrder", "isAvailable", "taxClassification", "createdAt", "updatedAt")
SELECT gen_random_uuid(), '2148ed5a-2e81-43c2-a90d-91c51b40c465', 'd2039125-680b-4aad-bf26-d7670630da99', 'Beef tartare', 'Capers, cured yolk, sourdough crisp.', 175000, 3, true, 'standard', NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM menu_items WHERE "conceptId" = '2148ed5a-2e81-43c2-a90d-91c51b40c465' AND name = 'Beef tartare' AND "deletedAt" IS NULL);

-- Large Plates
INSERT INTO menu_items (id, "conceptId", "categoryId", name, description, "priceCents", "displayOrder", "isAvailable", "taxClassification", "createdAt", "updatedAt")
SELECT gen_random_uuid(), '2148ed5a-2e81-43c2-a90d-91c51b40c465', '5ebb1f32-dde8-4770-bf1d-3a124f14b613', 'Lamb shoulder', 'Soft polenta, jus, gremolata.', 280000, 1, true, 'standard', NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM menu_items WHERE "conceptId" = '2148ed5a-2e81-43c2-a90d-91c51b40c465' AND name = 'Lamb shoulder' AND "deletedAt" IS NULL);

INSERT INTO menu_items (id, "conceptId", "categoryId", name, description, "priceCents", "displayOrder", "isAvailable", "taxClassification", "createdAt", "updatedAt")
SELECT gen_random_uuid(), '2148ed5a-2e81-43c2-a90d-91c51b40c465', '5ebb1f32-dde8-4770-bf1d-3a124f14b613', 'Hand-cut tagliatelle', 'Brown butter, sage, aged parmesan.', 220000, 2, true, 'standard', NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM menu_items WHERE "conceptId" = '2148ed5a-2e81-43c2-a90d-91c51b40c465' AND name = 'Hand-cut tagliatelle' AND "deletedAt" IS NULL);

INSERT INTO menu_items (id, "conceptId", "categoryId", name, description, "priceCents", "displayOrder", "isAvailable", "taxClassification", "createdAt", "updatedAt")
SELECT gen_random_uuid(), '2148ed5a-2e81-43c2-a90d-91c51b40c465', '5ebb1f32-dde8-4770-bf1d-3a124f14b613', 'Seared duck breast', 'Charred plum, turnip, five-spice jus.', 295000, 3, true, 'standard', NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM menu_items WHERE "conceptId" = '2148ed5a-2e81-43c2-a90d-91c51b40c465' AND name = 'Seared duck breast' AND "deletedAt" IS NULL);

-- Desserts
INSERT INTO menu_items (id, "conceptId", "categoryId", name, description, "priceCents", "displayOrder", "isAvailable", "taxClassification", "createdAt", "updatedAt")
SELECT gen_random_uuid(), '2148ed5a-2e81-43c2-a90d-91c51b40c465', '7ff91f38-92f8-4678-8bd8-bd38c1c4979f', 'Olive oil chocolate cake', 'Maldon flake, whipped creme fraiche.', 95000, 1, true, 'standard', NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM menu_items WHERE "conceptId" = '2148ed5a-2e81-43c2-a90d-91c51b40c465' AND name = 'Olive oil chocolate cake' AND "deletedAt" IS NULL);

INSERT INTO menu_items (id, "conceptId", "categoryId", name, description, "priceCents", "displayOrder", "isAvailable", "taxClassification", "createdAt", "updatedAt")
SELECT gen_random_uuid(), '2148ed5a-2e81-43c2-a90d-91c51b40c465', '7ff91f38-92f8-4678-8bd8-bd38c1c4979f', 'Cardamom panna cotta', 'Roasted apricot, honeycomb shard.', 90000, 2, true, 'standard', NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM menu_items WHERE "conceptId" = '2148ed5a-2e81-43c2-a90d-91c51b40c465' AND name = 'Cardamom panna cotta' AND "deletedAt" IS NULL);

INSERT INTO menu_items (id, "conceptId", "categoryId", name, description, "priceCents", "displayOrder", "isAvailable", "taxClassification", "createdAt", "updatedAt")
SELECT gen_random_uuid(), '2148ed5a-2e81-43c2-a90d-91c51b40c465', '7ff91f38-92f8-4678-8bd8-bd38c1c4979f', 'Bone marrow caramel', 'Salted caramel, burnt-butter ice.', 105000, 3, true, 'standard', NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM menu_items WHERE "conceptId" = '2148ed5a-2e81-43c2-a90d-91c51b40c465' AND name = 'Bone marrow caramel' AND "deletedAt" IS NULL);

-- Mocktails
INSERT INTO menu_items (id, "conceptId", "categoryId", name, description, "priceCents", "displayOrder", "isAvailable", "taxClassification", "createdAt", "updatedAt")
SELECT gen_random_uuid(), '2148ed5a-2e81-43c2-a90d-91c51b40c465', '7fa06ad1-966b-4420-a8b4-f5c2f3a2ad72', 'Garden Spritz', 'Basil, lime, cucumber, house soda.', 85000, 1, true, 'standard', NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM menu_items WHERE "conceptId" = '2148ed5a-2e81-43c2-a90d-91c51b40c465' AND name = 'Garden Spritz' AND "deletedAt" IS NULL);

INSERT INTO menu_items (id, "conceptId", "categoryId", name, description, "priceCents", "displayOrder", "isAvailable", "taxClassification", "createdAt", "updatedAt")
SELECT gen_random_uuid(), '2148ed5a-2e81-43c2-a90d-91c51b40c465', '7fa06ad1-966b-4420-a8b4-f5c2f3a2ad72', 'Negroni, sin', 'Non-alc bitters, blood orange, oleo.', 95000, 2, true, 'standard', NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM menu_items WHERE "conceptId" = '2148ed5a-2e81-43c2-a90d-91c51b40c465' AND name = 'Negroni, sin' AND "deletedAt" IS NULL);

INSERT INTO menu_items (id, "conceptId", "categoryId", name, description, "priceCents", "displayOrder", "isAvailable", "taxClassification", "createdAt", "updatedAt")
SELECT gen_random_uuid(), '2148ed5a-2e81-43c2-a90d-91c51b40c465', '7fa06ad1-966b-4420-a8b4-f5c2f3a2ad72', 'Smoked Old Fashioned', 'Smoked cherry, char, sugar. Non-alc.', 95000, 3, true, 'standard', NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM menu_items WHERE "conceptId" = '2148ed5a-2e81-43c2-a90d-91c51b40c465' AND name = 'Smoked Old Fashioned' AND "deletedAt" IS NULL);
