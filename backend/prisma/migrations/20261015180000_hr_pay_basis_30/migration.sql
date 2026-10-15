-- 20261015180000_hr_pay_basis_30 — owner decision HR-1 (2026-10-15): pay is on a
-- 30-day basis, as in Danish's sheet (26 is the company's TRADING days, not the
-- pay basis). The daily rate (absences, unpaid leave, lates, overtime, leave
-- encashment) becomes gross ÷ 30. The code default changes with it; this moves
-- every company that saved the old default. A company that saved another value
-- keeps it. HR can still change it in HR → Settings.
SET lock_timeout = '10s';
UPDATE "settings"
   SET "value" = replace("value", '"workingDaysPerMonth":26', '"workingDaysPerMonth":30'),
       "updatedAt" = CURRENT_TIMESTAMP
 WHERE "key" LIKE 'hr.settings.%'
   AND "value" LIKE '%"workingDaysPerMonth":26,%';
