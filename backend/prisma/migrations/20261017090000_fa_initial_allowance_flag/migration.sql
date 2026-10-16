-- Hasnain H42 (2026-10-16): the 25% initial allowance (ITO 2001 Third
-- Schedule) is decided PER ASSET. Finance ticks "eligible for initial
-- allowance" on each asset; it starts ticked for kitchen equipment and
-- generators & power, unticked for office, IT and every other class.
-- Tax view only: book depreciation never reads it. Tax years the CEO froze
-- (fixed_asset_tax_years) are not recomputed.
ALTER TABLE "fixed_assets" ADD COLUMN "initialAllowanceEligible" BOOLEAN;

-- Existing assets: the same class rule (current kitchen / power keep 25%,
-- office / IT and the rest are unticked until finance ticks them).
UPDATE "fixed_assets"
   SET "initialAllowanceEligible" = ("category" IN ('kitchen_equipment', 'power_equipment'))
 WHERE "initialAllowanceEligible" IS NULL;
