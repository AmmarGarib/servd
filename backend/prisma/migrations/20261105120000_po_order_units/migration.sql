-- 20261105120000_po_order_units — a PO line remembers the unit it was ordered in and the rate per that unit
-- (owner, 2026-11-05). Quantities and unit cost stay in the item's stock unit; nothing existing changes.
-- Runbook: if this migration fails on deploy, run
--   prisma migrate resolve --rolled-back 20261105120000_po_order_units
-- in the api image before redeploying any image.
SET lock_timeout = '10s';
ALTER TABLE "purchase_order_lines" ADD COLUMN "orderUnit" TEXT;
ALTER TABLE "purchase_order_lines" ADD COLUMN "orderUnitFactor" DOUBLE PRECISION NOT NULL DEFAULT 1;
ALTER TABLE "purchase_order_lines" ADD COLUMN "orderUnitCostCents" INTEGER;
