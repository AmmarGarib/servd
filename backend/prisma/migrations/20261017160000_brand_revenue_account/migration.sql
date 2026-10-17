-- One sales account per brand (owner, 2026-10-17: "One sales account per brand").
--
-- Each brand records the 40xx revenue account its sales are credited to, in
-- its OWN company's chart. The brands with a fixed code (CONCEPT_REVENUE_CODE
-- in accounting/journal.ts: simmer 4001, stackd / stax 4002, strata 4003,
-- flipd 4004, garnish-station 4005, stax-padel 4006, bukhari 4007) are
-- backfilled here with that code. Every other brand stays NULL here and gets
-- its own "Sales — <brand>" account (first free code in 4010–4089 of its
-- company) from the boot step accounting/brandRevenueAccount.ts
-- ensureBrandRevenueAccounts — accounts are created per company through the
-- chart helpers, not in SQL. Until then it keeps posting to 4090.
--
-- Past entries are never moved: sales already credited to 4090 stay there,
-- and their refunds reverse 4090 (orderPosting.ts saleBookingOf).
--
-- Rollback: an older image ignores the column (it maps by slug again and
-- posts the new brands' sales to 4090; refunds of sales booked on a brand's
-- own account would then debit 4090 — run no such rollback once a brand has
-- sales on its own account without re-posting by hand).
ALTER TABLE "concepts" ADD COLUMN "revenueAccountCode" TEXT;

UPDATE "concepts" SET "revenueAccountCode" = CASE "slug"
  WHEN 'simmer'          THEN '4001'
  WHEN 'stackd'          THEN '4002'
  WHEN 'stax'            THEN '4002'
  WHEN 'strata'          THEN '4003'
  WHEN 'flipd'           THEN '4004'
  WHEN 'garnish-station' THEN '4005'
  WHEN 'stax-padel'      THEN '4006'
  WHEN 'bukhari'         THEN '4007'
END
WHERE "revenueAccountCode" IS NULL
  AND "slug" IN ('simmer', 'stackd', 'stax', 'strata', 'flipd', 'garnish-station', 'stax-padel', 'bukhari');
