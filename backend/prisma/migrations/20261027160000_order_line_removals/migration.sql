-- 20261027160000_order_line_removals — removals on an order line (owner,
-- 2026-10-27: "removals = any item that is being deducted from stock will be
-- adjusted if customer asks to remove").
--
--   order_items.removedIngredients   JSON array of { masterIngredientId |
--                                    inventoryItemId | prepRecipeId, name }:
--                                    the dish's plate-recipe lines the customer
--                                    asked to leave out ("No onions"). The sale
--                                    draws none of them (lib/recipeCost.ts);
--                                    null = none. The line's company is its
--                                    order's (order_items carries no tenantId).
-- Nothing is dropped; additive and nullable, so an older image ignores it.
--
-- Runbook: if this migration fails on deploy, run
--   prisma migrate resolve --rolled-back 20261027160000_order_line_removals
-- in the api image before redeploying any image (P3009 blocks every image).
SET lock_timeout = '10s';

ALTER TABLE "order_items" ADD COLUMN "removedIngredients" JSONB;
