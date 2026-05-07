ALTER TABLE "menu_items" ADD COLUMN "allergens"  TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "menu_items" ADD COLUMN "dietary"    TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "menu_items" ADD COLUMN "spiceLevel" INTEGER;
