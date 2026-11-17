-- The unit an ingredient is shown and priced in (owner, 2026-11-17: "change price per kg to price per stock unit
-- everywhere. And let stock unit be selected"). NULL = the stock unit itself (g / ml / pcs). Display only.
ALTER TABLE "ingredient_masters" ADD COLUMN "priceUnit" TEXT;
