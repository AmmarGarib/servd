-- 20261015180000_hr_pay_basis_30 — owner decision HR-1 (2026-10-16): pay is on
-- the ACTUAL days of each month (28–31), the same basis servd already prorates a
-- joiner's or leaver's month on. 26 is the company's TRADING days, not the pay
-- basis. The daily rate (absences, unpaid leave, lates, overtime, leave
-- encashment) becomes gross ÷ the days of that month; the setting stores 0 for
-- "actual days". The code default changes with it; this moves every company
-- that saved the old default of 26. A company that saved another value keeps
-- it. HR can change it in HR → Settings → Pay days.
SET lock_timeout = '10s';
UPDATE "settings"
   SET "value" = replace("value", '"workingDaysPerMonth":26', '"workingDaysPerMonth":0'),
       "updatedAt" = CURRENT_TIMESTAMP
 WHERE "key" LIKE 'hr.settings.%'
   AND "value" LIKE '%"workingDaysPerMonth":26,%';
