-- Owner, 2026-10-15: GS Foods is not registered with PRA (Punjab), KPRA (KP)
-- or BRA (Balochistan). Their sales-tax accounts leave every company's chart:
--   1321 PRA input, 1323 KPRA input, 1324 BRA input,
--   2031 PRA output, 2033 KPRA output, 2034 BRA output.
-- The code no longer knows these authorities (accounting/taxAuthorities.ts)
-- and ensureChartOfAccounts no longer adds them.
--
-- An account that ever carried a journal line is NOT deleted (the books keep
-- their history); it is switched off instead, so it disappears from pickers
-- and nothing new can post to it. Unused ones are deleted.

UPDATE "accounts" a
   SET "isActive" = false, "updatedAt" = now()
 WHERE a."code" IN ('1321', '1323', '1324', '2031', '2033', '2034')
   AND EXISTS (SELECT 1 FROM "journal_lines" l WHERE l."accountId" = a."id");

DELETE FROM "accounts" a
 WHERE a."code" IN ('1321', '1323', '1324', '2031', '2033', '2034')
   AND NOT EXISTS (SELECT 1 FROM "journal_lines" l WHERE l."accountId" = a."id");
