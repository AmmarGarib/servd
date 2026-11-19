-- 20261119100000_handmade_7_codes_are_opex — hand-made expense accounts that were given a 7-code (owner, 2026-11-19:
-- "Transportation / Delivery charges" and "Architect / Interior Design Fee" showed under Discounts / Refunds) are
-- ordinary running costs. Only servd's own 7010–7040 (discounts, loyalty redemptions, comps, refunds) are taken off
-- sales. Data only; finance can still move any account on the chart ("Shows in the P&L under").
UPDATE "accounts" SET "plSection" = 'operating_expense'
  WHERE "type" = 'expense' AND "plSection" = 'contra_revenue'
    AND "code" NOT IN ('7010', '7020', '7030', '7040');
