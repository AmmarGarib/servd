-- 20261118140000_account_pl_section — where an account shows in the P&L is STORED, never read from its code
-- (owner, 2026-11-18: "account code should not decide where an account balance will reflect in P&L or BS").
-- lib/accountSection.ts is the one reader. Additive: one nullable column + data.
-- If it fails on deploy: prisma migrate resolve --rolled-back 20261118140000_account_pl_section, then redeploy.

ALTER TABLE "accounts" ADD COLUMN "plSection" TEXT;

-- Every existing revenue / expense account keeps exactly the section the reports gave it until today.
UPDATE "accounts" SET "plSection" = CASE
    WHEN "type" = 'revenue' AND "code" LIKE '42%' THEN 'other_income'
    WHEN "type" = 'revenue' THEN 'revenue'
    WHEN "type" = 'expense' AND "code" LIKE '5%' THEN 'cost_of_sales'
    WHEN "type" = 'expense' AND "code" LIKE '7%' THEN 'contra_revenue'
    ELSE 'operating_expense' END
  WHERE "type" IN ('revenue', 'expense');

-- The owner's case: a hand-made IT / computer / software expense account that got a 5-code is an operating expense.
-- Never servd's own cost-of-sales accounts (5010–5060).
UPDATE "accounts" SET "plSection" = 'operating_expense'
  WHERE "type" = 'expense' AND "plSection" = 'cost_of_sales'
    AND "code" NOT IN ('5010', '5020', '5030', '5040', '5050', '5060')
    AND "name" ~* '(^|[^a-z])(it|i\.t\.?|computers?|software)([^a-z]|$)';

-- Current / non-current stored on every asset / liability account that had only the default by code.
UPDATE "accounts" SET "classification" = CASE
    WHEN "type" = 'asset' AND "code" ~ '^\s*\d{4}' AND (
           substring("code" from '^\s*(\d{4})')::int BETWEEN 1500 AND 1599
        OR substring("code" from '^\s*(\d{4})')::int = 1360
        OR substring("code" from '^\s*(\d{4})')::int >= 1600) THEN 'non_current'
    WHEN "type" = 'liability' AND "code" ~ '^\s*\d{4}' AND substring("code" from '^\s*(\d{4})')::int >= 2200 THEN 'non_current'
    ELSE 'current' END
  WHERE "classification" IS NULL AND "type" IN ('asset', 'liability');
