-- Sub-accounts per account are switched on deliberately (owner, 2026-10-23: "It should not automatically pick
-- sub accounts for all wages heads, make it limited to Wages Expense (HO) account only, and add an option to
-- switch on sub accounts for other head accounts also only in those for which i open subaccount").
ALTER TABLE "accounts" ADD COLUMN "subAccountsEnabled" BOOLEAN NOT NULL DEFAULT false;

-- Accounts where someone opened a sub-account by hand.
UPDATE "accounts" a SET "subAccountsEnabled" = true
 WHERE EXISTS (SELECT 1 FROM "sub_accounts" s WHERE s."accountId" = a.id AND s.kind = 'manual');

-- The head-office wages account of each company: a wages account whose name says HO / head office…
UPDATE "accounts" a SET "subAccountsEnabled" = true
 WHERE a.name ~* '(wage|salar)' AND a.name ~* '(\(HO\)|\mHO\M|head office)';

-- …else 6032, where payroll books office / admin / finance / management staff (hr/ledger.ts wageAccountFor).
UPDATE "accounts" a SET "subAccountsEnabled" = true
 WHERE a.code = '6032'
   AND NOT EXISTS (SELECT 1 FROM "accounts" b WHERE b."tenantId" IS NOT DISTINCT FROM a."tenantId"
                    AND b.name ~* '(wage|salar)' AND b.name ~* '(\(HO\)|\mHO\M|head office)');
