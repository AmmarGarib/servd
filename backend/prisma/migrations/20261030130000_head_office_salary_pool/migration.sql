-- Owner, 2026-10-30: "head office is just a salary splitting entity. no expenses to be
-- charged other than salary splitting." The cost pool is the wages accounts 6030–6036 only.
ALTER TABLE "head_office_books" ALTER COLUMN "costPool" SET DEFAULT '{"include":[{"from":6030,"to":6036}],"includeCodes":[],"excludeCodes":[]}'::jsonb;
-- Any head office already set up: salaries only, and its CA confirmation / recharge switch
-- start again (the pool changed), the way a pool edit does.
UPDATE "head_office_books"
   SET "costPool" = '{"include":[{"from":6030,"to":6036}],"includeCodes":[],"excludeCodes":[]}'::jsonb,
       "accountsConfirmedAt" = NULL, "accountsConfirmedById" = NULL, "accountsConfirmedNote" = NULL,
       "rechargeEnabled" = false
 WHERE "costPool" <> '{"include":[{"from":6030,"to":6036}],"includeCodes":[],"excludeCodes":[]}'::jsonb;
