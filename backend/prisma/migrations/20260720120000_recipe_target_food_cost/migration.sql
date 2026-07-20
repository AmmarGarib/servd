-- Per-recipe pricing target: the food-cost % the operator wants this item to
-- run at. Drives the "price to hit target FC" suggestion on Menu Engineering.
-- Default 30% (the classic rule of thumb already used by foodCostPrice).
ALTER TABLE "recipes" ADD COLUMN IF NOT EXISTS "targetFoodCostPct" DOUBLE PRECISION NOT NULL DEFAULT 30;
