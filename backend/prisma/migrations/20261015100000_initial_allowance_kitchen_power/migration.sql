-- Hasnain H42 (2026-10-15): the 25% initial allowance (ITO Third Schedule)
-- applies to kitchen equipment and generators & power only. Office and IT
-- equipment get 0%. Only rows still on the old default (2500) change; a rate
-- the CEO edited is kept. Tax years already frozen are not recomputed.
UPDATE "fixed_asset_classes"
   SET "taxInitialAllowanceBp" = 0, "updatedAt" = now()
 WHERE "key" IN ('office_equipment', 'it_equipment')
   AND "taxInitialAllowanceBp" = 2500;
