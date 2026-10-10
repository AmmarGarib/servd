-- BOOKS-14: Stax was renamed Stackd (2026-09-09), but account 4002 in every
-- company's chart still read "Revenue — Stax", so the P&L, trial balance,
-- ledger CSV and sales-tax return showed Stackd's sales under the old name.
-- The starting chart (lib/chartOfAccounts.ts) now says "Revenue — Stackd".
--
-- Rename ONLY rows whose name is still the old seeded default: an operator who
-- renamed 4002 to something of their own keeps it. 4006 ("Revenue — Stax @
-- Padel") is a separate business that kept its name and is not touched.
-- Data only; idempotent (a second run matches nothing).
UPDATE "accounts"
SET "name" = 'Revenue — Stackd',
    "updatedAt" = NOW()
WHERE "code" = '4002'
  AND "name" = 'Revenue — Stax';
