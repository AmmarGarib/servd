-- Repair journal lines left pointing at another company's accounts.
--
-- Migration 20260908120000 split the ledger per company. It did two things in
-- the wrong order for a subset of rows:
--
--   1. It reassigned each journal_entry's tenantId to the company of a brand
--      named on its lines — so an entry could legitimately become company B's.
--   2. It assigned EVERY pre-existing account to the primary company.
--
-- An entry moved to company B therefore kept lines pointing at accounts owned
-- by company A. That entry then falls out of BOTH companies' reports: B's
-- reports look up accounts in B's chart and never match these ids, while A's
-- reports filter on entry tenantId and no longer match the entry. The revenue
-- is in the ledger and invisible in every report.
--
-- This remaps each such line onto the account with the SAME CODE in the owning
-- company's chart. Every company gets a full chart at boot
-- (lib/chartOfAccounts.ts), so the counterpart exists; where it somehow does
-- not, the line is left alone rather than silently repointed at nothing.
--
-- Almost certainly a no-op on the current production data — GS Foods is the
-- primary company and the second company has no history — but it is cheap, it
-- is idempotent, and the alternative is finding out later from a report that
-- doesn't add up.
UPDATE "journal_lines" jl
SET "accountId" = correct.id
FROM "journal_entries" je,
     "accounts" wrong,
     "accounts" correct
WHERE jl."journalEntryId" = je.id
  AND wrong.id            = jl."accountId"
  AND je."tenantId"      IS NOT NULL
  AND wrong."tenantId"   IS DISTINCT FROM je."tenantId"
  AND correct."tenantId"  = je."tenantId"
  AND correct.code        = wrong.code;
