-- Promo codes are unique per company, not across every company (ONL-12).
--
-- `code` was globally unique, so a second company could not run a code another
-- company already had: the create failed with a 500 (Prisma P2002), and the
-- 500-versus-201 difference told one company which codes another company runs.
-- Every row already carries tenantId (backfilled by
-- 20260927160000_company_separation_columns), and checkout looks a code up in
-- the brand's company, so the key moves to (tenantId, code).
--
-- No data changes. Dropping the global index cannot fail; the new index cannot
-- fail either, because rows that were globally unique are unique per company.
DROP INDEX IF EXISTS "promo_codes_code_key";

CREATE UNIQUE INDEX "promo_codes_tenantId_code_key" ON "promo_codes"("tenantId", "code");
