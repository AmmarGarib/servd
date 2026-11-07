-- Item groups under a category (owner, 2026-11-07: "In PO, make item categories like Sea food, Sea food will contain
-- all types of fish, Meat will contain all kind of meat etc." — answer: groups under the existing category; the PO
-- maker can add groups). Platform data like ingredient_masters: no tenantId, deliberately.
CREATE TABLE "ingredient_groups" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "normalizedName" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ingredient_groups_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ingredient_groups_normalizedName_key" ON "ingredient_groups"("normalizedName");
CREATE INDEX "ingredient_groups_category_idx" ON "ingredient_groups"("category");

ALTER TABLE "ingredient_masters" ADD COLUMN "groupId" TEXT;
CREATE INDEX "ingredient_masters_groupId_idx" ON "ingredient_masters"("groupId");
ALTER TABLE "ingredient_masters" ADD CONSTRAINT "ingredient_masters_groupId_fkey"
  FOREIGN KEY ("groupId") REFERENCES "ingredient_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The starter groups (the CEO / PO makers add more on the PO form).
INSERT INTO "ingredient_groups" ("id", "name", "normalizedName", "category", "active", "createdAt", "updatedAt") VALUES
  (gen_random_uuid()::text, 'Meat', 'meat', 'protein', true, now(), now()),
  (gen_random_uuid()::text, 'Poultry', 'poultry', 'protein', true, now(), now()),
  (gen_random_uuid()::text, 'Sea food', 'sea food', 'protein', true, now(), now()),
  (gen_random_uuid()::text, 'Eggs', 'eggs', 'protein', true, now(), now()),
  (gen_random_uuid()::text, 'Vegetables', 'vegetables', 'produce', true, now(), now()),
  (gen_random_uuid()::text, 'Fruit', 'fruit', 'produce', true, now(), now()),
  (gen_random_uuid()::text, 'Fresh herbs', 'fresh herbs', 'produce', true, now(), now()),
  (gen_random_uuid()::text, 'Milk & cream', 'milk & cream', 'dairy', true, now(), now()),
  (gen_random_uuid()::text, 'Cheese', 'cheese', 'dairy', true, now(), now()),
  (gen_random_uuid()::text, 'Butter & yogurt', 'butter & yogurt', 'dairy', true, now(), now()),
  (gen_random_uuid()::text, 'Rice & pulses', 'rice & pulses', 'dry_goods', true, now(), now()),
  (gen_random_uuid()::text, 'Pasta & noodles', 'pasta & noodles', 'dry_goods', true, now(), now()),
  (gen_random_uuid()::text, 'Canned & jarred', 'canned & jarred', 'dry_goods', true, now(), now()),
  (gen_random_uuid()::text, 'Whole spices', 'whole spices', 'spices', true, now(), now()),
  (gen_random_uuid()::text, 'Ground spices', 'ground spices', 'spices', true, now(), now()),
  (gen_random_uuid()::text, 'Soft drinks', 'soft drinks', 'beverage', true, now(), now()),
  (gen_random_uuid()::text, 'Juices', 'juices', 'beverage', true, now(), now()),
  (gen_random_uuid()::text, 'Coffee & tea', 'coffee & tea', 'beverage', true, now(), now()),
  (gen_random_uuid()::text, 'Water', 'water', 'beverage', true, now(), now()),
  (gen_random_uuid()::text, 'Boxes & containers', 'boxes & containers', 'packaging', true, now(), now()),
  (gen_random_uuid()::text, 'Bags & wraps', 'bags & wraps', 'packaging', true, now(), now()),
  (gen_random_uuid()::text, 'Cups & lids', 'cups & lids', 'packaging', true, now(), now()),
  (gen_random_uuid()::text, 'Cleaning', 'cleaning', 'non_food', true, now(), now()),
  (gen_random_uuid()::text, 'Stationery', 'stationery', 'non_food', true, now(), now())
ON CONFLICT ("normalizedName") DO NOTHING;
