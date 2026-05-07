-- Add unitCostCents to inventory_items
ALTER TABLE "inventory_items" ADD COLUMN "unitCostCents" INTEGER;

-- Add address/taxId to suppliers
ALTER TABLE "suppliers" ADD COLUMN "address" TEXT;
ALTER TABLE "suppliers" ADD COLUMN "taxId" TEXT;

-- Recipes
CREATE TABLE "recipes" (
  "id"           TEXT        NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "menuItemId"   TEXT        NOT NULL UNIQUE,
  "servings"     INTEGER     NOT NULL DEFAULT 1,
  "laborMinutes" INTEGER     NOT NULL DEFAULT 0,
  "notes"        TEXT,
  "createdAt"    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt"    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "recipes_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "menu_items"("id") ON DELETE RESTRICT
);

-- Recipe ingredients
CREATE TABLE "recipe_ingredients" (
  "id"              TEXT    NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "recipeId"        TEXT    NOT NULL,
  "inventoryItemId" TEXT    NOT NULL,
  "quantity"        DOUBLE PRECISION NOT NULL,
  "unit"            TEXT    NOT NULL,
  "notes"           TEXT,
  CONSTRAINT "recipe_ingredients_recipeId_fkey"        FOREIGN KEY ("recipeId")        REFERENCES "recipes"("id")         ON DELETE CASCADE,
  CONSTRAINT "recipe_ingredients_inventoryItemId_fkey" FOREIGN KEY ("inventoryItemId") REFERENCES "inventory_items"("id") ON DELETE RESTRICT
);

-- Purchase orders
CREATE TABLE "purchase_orders" (
  "id"           TEXT        NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "supplierId"   TEXT        NOT NULL,
  "status"       TEXT        NOT NULL DEFAULT 'draft',
  "orderDate"    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "expectedDate" TIMESTAMPTZ,
  "receivedDate" TIMESTAMPTZ,
  "reference"    TEXT,
  "notes"        TEXT,
  "totalCents"   INTEGER     NOT NULL DEFAULT 0,
  "createdBy"    TEXT,
  "createdAt"    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt"    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "purchase_orders_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT
);

-- Purchase order lines
CREATE TABLE "purchase_order_lines" (
  "id"               TEXT             NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "purchaseOrderId"  TEXT             NOT NULL,
  "inventoryItemId"  TEXT             NOT NULL,
  "quantityOrdered"  DOUBLE PRECISION NOT NULL,
  "quantityReceived" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "unitCostCents"    INTEGER          NOT NULL,
  "notes"            TEXT,
  CONSTRAINT "purchase_order_lines_purchaseOrderId_fkey"  FOREIGN KEY ("purchaseOrderId")  REFERENCES "purchase_orders"("id")   ON DELETE CASCADE,
  CONSTRAINT "purchase_order_lines_inventoryItemId_fkey"  FOREIGN KEY ("inventoryItemId")  REFERENCES "inventory_items"("id")   ON DELETE RESTRICT
);

-- Indexes
CREATE INDEX "recipe_ingredients_recipeId_idx"        ON "recipe_ingredients"("recipeId");
CREATE INDEX "recipe_ingredients_inventoryItemId_idx" ON "recipe_ingredients"("inventoryItemId");
CREATE INDEX "purchase_orders_supplierId_idx"         ON "purchase_orders"("supplierId");
CREATE INDEX "purchase_order_lines_purchaseOrderId_idx" ON "purchase_order_lines"("purchaseOrderId");
