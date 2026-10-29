-- Prices typed on the Ingredients sheet (owner, 2026-10-29). servd-wide platform data (no tenantId, like
-- ingredient_masters): every edit is a new row.
CREATE TABLE "ingredient_master_prices" (
    "id" TEXT NOT NULL,
    "masterIngredientId" TEXT NOT NULL,
    "perBaseCents" DOUBLE PRECISION NOT NULL,
    "setById" TEXT,
    "setAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ingredient_master_prices_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ingredient_master_prices_positive_chk" CHECK ("perBaseCents" > 0)
);
CREATE INDEX "ingredient_master_prices_masterIngredientId_setAt_idx" ON "ingredient_master_prices"("masterIngredientId", "setAt");
ALTER TABLE "ingredient_master_prices" ADD CONSTRAINT "ingredient_master_prices_masterIngredientId_fkey"
  FOREIGN KEY ("masterIngredientId") REFERENCES "ingredient_masters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
